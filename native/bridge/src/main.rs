mod apps;
mod ax;
mod configuration;
mod device_ops;
mod gesture;
mod installation;
mod pasteboard;
mod remote;
mod execution_receipt;
mod stream;
mod session_input;

use gesture::{Drag, Pinch, Strokes, pinch_contacts};
use idevice::{
    IdeviceService, ReadWrite, RsdService,
    core_device::hid::{
        ButtonState, IndigoHidClient, KeyboardUsage, MainKeyboardService,
        TOUCHSCREEN_STATE_CONTACT, TOUCHSCREEN_STATE_RELEASE, UniversalHidServiceClient,
    },
    core_device_proxy::CoreDeviceProxy,
    rsd::RsdHandshake,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Read, time::Duration};
use stream::NoDisplayService;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Touch = UniversalHidServiceClient<Box<dyn ReadWrite>>;
type Indigo = IndigoHidClient<Box<dyn ReadWrite>>;
fn trace(stage: &str) {
    if std::env::var_os("POKI_MCP_NATIVE_TRACE").is_some() {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let elapsed = START.get_or_init(std::time::Instant::now).elapsed();
        eprintln!("native stage: {stage} (+{} ms)", elapsed.as_millis());
    }
}
struct InputMedia {
    client: idevice::core_device::DisplayServiceClient<Box<dyn ReadWrite>>,
    receivers: tokio::task::JoinSet<()>,
    ready_at: tokio::time::Instant,
    touch: Option<Touch>,
    keyboard: Option<Keyboard>,
}

impl InputMedia {
    async fn connect(
        adapter: &mut idevice::tcp::handle::AdapterHandle,
        rsd: &mut RsdHandshake,
    ) -> Result<Self> {
        let stream = stream::start_input_media_stream(adapter, rsd, 1)
            .await
            .map_err(|e| {
                if e.is::<NoDisplayService>() {
                    e
                } else if let Some(io) = e.downcast_ref::<std::io::Error>() {
                    std::io::Error::new(
                        io.kind(),
                        format!("Cannot establish input media session: {e}"),
                    )
                    .into()
                } else {
                    format!("Cannot establish input media session: {e}").into()
                }
            })?;
        let mut receivers = tokio::task::JoinSet::new();
        // The transport queues UDP without a bound. Consume packets while holding the input gate open.
        for socket in stream.audio_udp.into_iter().chain(std::iter::once(stream.video_udp)) {
            receivers.spawn(async move { while socket.recv().await.is_ok() {} });
        }
        trace("input media connected");
        Ok(Self {
            client: stream.client,
            receivers,
            // Upstream pymobiledevice3 #2036 requires 500ms on slower phones;
            // never remove this asynchronous HID authentication settle period.
            ready_at: tokio::time::Instant::now() + Duration::from_millis(500),
            touch: None,
            keyboard: None,
        })
    }
}

/// Connecting or opening a phone service failed, so no input reached the phone.
#[derive(Debug)]
struct NotSent(Box<dyn std::error::Error + Send + Sync>);
impl std::fmt::Display for NotSent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for NotSent {}
fn not_sent_error(
    error: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(NotSent(error.into()))
}

async fn close_input(media: &mut Option<InputMedia>) -> Result<()> {
    if let Some(mut media) = media.take() {
        let keyboard_result: Result<()> = async {
            if let Some(mut keyboard) = media.keyboard.take() {
                tokio::time::timeout(Duration::from_secs(2), keyboard.close()).await??;
            }
            Ok(())
        }.await;
        media.touch = None;
        let result =
            tokio::time::timeout(Duration::from_secs(2), media.client.stop_media_stream()).await;
        media.receivers.shutdown().await;
        trace("input media closed");
        keyboard_result?;
        result??;
    }
    Ok(())
}

struct Keyboard {
    hid: Touch,
    service: MainKeyboardService,
}
impl Keyboard {
    async fn connect(
        adapter: &mut idevice::tcp::handle::AdapterHandle,
        rsd: &mut RsdHandshake,
    ) -> Result<Self> {
        trace("keyboard connect");
        let mut hid = Touch::connect_rsd(adapter, rsd)
            .await
            .map_err(not_sent_error)?;
        trace("keyboard create");
        let service = hid.create_main_keyboard().await.map_err(not_sent_error)?;
        trace("keyboard ready");
        tokio::time::sleep(Duration::from_millis(150)).await;
        Ok(Self { hid, service })
    }
    async fn close(&mut self) -> Result<()> {
        self.hid.remove_main_keyboard(&mut self.service).await?;
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequencePoint {
    x: u16,
    y: u16,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    DisplayInfo,
    Screenshot {
        path: String,
    },
    DeviceInfo,
    ListApps,
    InstallApp {
        ipa_path: String,
        bundle_id: String,
        staging_id: String,
    },
    UninstallApp {
        bundle_id: String,
    },
    LaunchApp(apps::LaunchRequest),
    OpenUrl { url: String },
    Configuration {
        method: String,
        #[serde(default)]
        value: Option<Value>,
    },
    AxTree {
        #[serde(default)]
        include_offscreen: bool,
        #[serde(default = "ax_timeout")]
        timeout_ms: u64,
        #[serde(default)]
        event_stream: bool,
    },
    /// Names the app running as `pid`, for an accessibility root that carries no bundle ID.
    AppForPid {
        pid: u32,
    },
    /// Reads (`get`, `items`) or sets the general pasteboard's text.
    Pasteboard {
        action: String,
        #[serde(default)]
        text: Option<String>,
    },
    Tap {
        x: u16,
        y: u16,
        #[serde(default = "tap_duration")]
        duration_ms: u64,
    },
    TapSequence {
        points: Vec<SequencePoint>,
        #[serde(default = "tap_duration")]
        duration_ms: u64,
        #[serde(default = "tap_duration")]
        interval_ms: u64,
    },
    DoubleTap {
        x: u16,
        y: u16,
        #[serde(default = "tap_duration")]
        duration_ms: u64,
    },
    LongPress {
        x: u16,
        y: u16,
        #[serde(default = "long_duration")]
        duration_ms: u64,
    },
    Drag {
        x1: u16,
        y1: u16,
        x2: u16,
        y2: u16,
        #[serde(default = "drag_duration")]
        duration_ms: u64,
        #[serde(default)]
        hold_ms: u64,
        #[serde(default)]
        end_hold_ms: u64,
    },
    Pinch {
        x: u16,
        y: u16,
        start_distance: f64,
        end_distance: f64,
        #[serde(default)]
        angle: f64,
        #[serde(default = "drag_duration")]
        duration_ms: u64,
    },
    DrawStrokes {
        strokes: Strokes,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default = "one")]
        count: usize,
    },
    Button {
        button: String,
        #[serde(default = "one")]
        count: usize,
        #[serde(default = "button_interval")]
        interval_ms: u64,
    },
    TypeText {
        text: String,
        #[serde(default)]
        clear: bool,
        #[serde(default)]
        submit: bool,
        #[serde(default)]
        target: Option<pasteboard::Target>,
    },
    /// Types text as hardware key presses into whatever is being edited, without the pasteboard.
    TypeKeys {
        text: String,
        #[serde(default)]
        clear: bool,
    },
}
fn ax_timeout() -> u64 { 20000 }
fn tap_duration() -> u64 {
    50
}
fn long_duration() -> u64 {
    600
}
fn drag_duration() -> u64 {
    500
}
fn one() -> usize {
    1
}
fn button_interval() -> u64 {
    120
}

impl Request {
    fn read_only(&self) -> bool {
        matches!(
            self,
            Self::AxTree { .. }
                | Self::AppForPid { .. }
                | Self::Screenshot { .. }
                | Self::DeviceInfo
                | Self::DisplayInfo
                | Self::ListApps
        )
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::TapSequence { points, duration_ms, interval_ms } => {
                if !(2..=8).contains(&points.len()) || !(30..=150).contains(duration_ms) || !(30..=250).contains(interval_ms) {
                    return Err("tap_sequence requires 2..8 points, duration_ms 30..150 and interval_ms 30..250".into());
                }
            }
            Self::AxTree { timeout_ms, .. } if !(1..=20000).contains(timeout_ms) => return Err("AX timeout_ms must be 1..20000".into()),
            Self::LaunchApp(request) => request.validate()?,
            Self::OpenUrl { url } => { apps::open_url_payload(url)?; }
            Self::InstallApp { bundle_id, .. } | Self::UninstallApp { bundle_id }
                if bundle_id.is_empty() =>
            {
                return Err("bundle_id must not be empty".into());
            }
            Self::Configuration { method, value } => match method.as_str() {
                "get_increase_contrast" | "get_larger_accessibility_sizes" if value.is_none() => {}
                "set_larger_accessibility_sizes"
                    if value.as_ref().and_then(Value::as_bool).is_some() => {}
                _ => return Err("Invalid configuration method or value".into()),
            },
            Self::Tap { duration_ms, .. }
            | Self::DoubleTap { duration_ms, .. }
            | Self::LongPress { duration_ms, .. }
            | Self::Drag { duration_ms, .. }
            | Self::Pinch { duration_ms, .. }
                if !(1..=60000).contains(duration_ms) =>
            {
                return Err("duration_ms must be 1..60000".into());
            }
            Self::Key {
                key,
                modifiers,
                count,
            } => {
                key_usage(key)?;
                for modifier in modifiers {
                    modifier_usage(modifier)?;
                }
                if !(1..=200).contains(count) {
                    return Err("count must be 1..200".into());
                }
            }
            Self::Button {
                button,
                count,
                interval_ms,
            } => {
                button_usage(button)?;
                if !(1..=200).contains(count) || *interval_ms > 10000 {
                    return Err("Invalid button count or interval_ms".into());
                }
            }
            Self::AppForPid { pid: 0 } => return Err("pid must be positive".into()),
            Self::Pasteboard { action, text } => {
                device_ops::validate_pasteboard(action, text.as_deref())?
            }
            Self::TypeKeys { text, .. } => {
                if text.chars().count() > 2000 {
                    return Err("type_keys text is at most 2000 characters".into());
                }
                for c in text.chars() {
                    char_usage(c)?;
                }
            }
            Self::TypeText { text, .. } if text.len() > 1024 * 1024 => {
                return Err("text exceeds 1 MiB".into());
            }
            Self::DrawStrokes { strokes } => strokes.validate()?,
            _ => {}
        }
        if let Self::Drag {
            hold_ms,
            end_hold_ms,
            ..
        } = self
        {
            if *hold_ms > 10000 || *end_hold_ms > 10000 {
                return Err("hold_ms and end_hold_ms must not exceed 10000".into());
            }
        }
        if let Self::Pinch {
            x,
            y,
            start_distance,
            end_distance,
            angle,
            ..
        } = self
        {
            pinch_contacts(*x, *y, *start_distance, *angle, true)?;
            pinch_contacts(*x, *y, *end_distance, *angle, true)?;
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let result = async {
        let args: Vec<String> = std::env::args().collect();
        if args.len() == 2 && args[1] == "--build-info" {
            return Ok(execution_receipt::build_info());
        }
        if args.len() == 4 && args[1] == "--local-server" {
            return remote::serve_local(&args[2], &args[3]).await;
        }
        if args.len() == 4 && args[1] == "--remote-server" {
            return remote::serve_socket(&args[2], &args[3]).await;
        }
        if args.len() == 3 && args[1] == "--remote" {
            return remote::serve(&args[2]).await;
        }
        if args.len() != 3 || args[1] != "--udid" {
            return Err("usage: poki-native --udid ID < request.json".into());
        }
        let mut input = String::new();
        std::io::stdin()
            .take(2 * 1024 * 1024)
            .read_to_string(&mut input)?;
        let request: Request = serde_json::from_str(&input)?;
        request.validate()?;
        let limit = if matches!(request, Request::InstallApp { .. }) {
            180
        } else {
            90
        };
        tokio::time::timeout(Duration::from_secs(limit), execute(&args[2], request)).await?
    }
    .await;
    match result {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!(
                "{}",
                json!({"error": error.to_string(), "screen_change_verified": false})
            );
            std::process::exit(1);
        }
    }
}

async fn connect_device(
    udid: &str,
) -> Result<(
    idevice::tcp::handle::AdapterHandle,
    RsdHandshake,
    u16,
    idevice::provider::UsbmuxdProvider,
)> {
    let mut mux = UsbmuxdConnection::default().await?;
    let device = mux.get_device(udid).await?;
    let provider = device.to_provider(UsbmuxdAddr::from_env_var()?, "poki-mcp");
    let proxy = CoreDeviceProxy::connect(&provider).await?;
    let port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy.create_software_tunnel()?.to_async_handle();
    let rsd = RsdHandshake::new(adapter.connect(port).await?).await?;
    Ok((adapter, rsd, port, provider))
}

async fn execute(udid: &str, request: Request) -> Result<Value> {
    if matches!(
        request,
        Request::InstallApp { .. } | Request::UninstallApp { .. }
    ) {
        let result = async {
            let mut mux = UsbmuxdConnection::default().await?;
            let device = mux.get_device(udid).await?;
            let provider = device.to_provider(UsbmuxdAddr::from_env_var()?, "poki-mcp");
            match request {
                Request::InstallApp {
                    ipa_path,
                    bundle_id,
                    staging_id,
                } => {
                    installation::install(
                        &provider,
                        std::path::Path::new(&ipa_path),
                        &bundle_id,
                        &staging_id,
                    )
                    .await
                }
                Request::UninstallApp { bundle_id } => {
                    installation::uninstall(&provider, &bundle_id).await
                }
                _ => unreachable!(),
            }
        }
        .await;
        return Ok(result.unwrap_or_else(
            |error| json!({"isError":true,"outcome":"not_sent","error":error.to_string()}),
        ));
    }
    let connection = connect_device(udid).await;
    let (mut adapter, mut rsd, _, provider) = match connection {
        Ok(connection) => connection,
        Err(error) if matches!(request, Request::LaunchApp(_)) => return Ok(apps::not_sent(error)),
        Err(error) => return Err(error),
    };
    let launch = matches!(request, Request::LaunchApp(_));
    let mut media = None;
    let mut observer = None;
    let result =
        execute_connected(&mut adapter, &mut rsd, Some(&provider), request, &mut media, &mut observer).await;
    let closed = close_input(&mut media).await;
    let output = match result {
        Err(error) if launch => apps::not_sent(error),
        result => result?,
    };
    closed?;
    Ok(output)
}

async fn execute_connected(
    adapter: &mut idevice::tcp::handle::AdapterHandle,
    rsd: &mut RsdHandshake,
    provider: Option<&dyn idevice::provider::IdeviceProvider>,
    request: Request,
    media: &mut Option<InputMedia>,
    observer: &mut Option<ax::Monitor>,
) -> Result<Value> {
    execution_receipt::measure(async {
    if let Request::OpenUrl { url } = request {
        *observer = None;
        close_input(media).await.map_err(not_sent_error)?;
        return apps::open_url(adapter, rsd, &url).await;
    }
    if let Request::LaunchApp(request) = request {
        *observer = None;
        close_input(media).await?;
        return match apps::launch(adapter, rsd, request).await {
            Err(error) if error.is::<NotSent>() => Err(error),
            result => Ok(result.unwrap_or_else(apps::not_sent)),
        };
    }
    if let Request::Screenshot { path } = request {
        let mut dvt =
            idevice::dvt::remote_server::RemoteServerClient::connect_rsd(adapter, rsd).await?;
        dvt.read_message(0).await?;
        let mut screenshot = idevice::dvt::screenshot::ScreenshotClient::new(&mut dvt).await?;
        let bytes = screenshot.take_screenshot().await?;
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(&bytes)?;
        return Ok(json!({"saved":true}));
    }
    if matches!(request, Request::DeviceInfo) {
        let mut lockdown = idevice::lockdown::LockdownClient::connect_rsd(adapter, rsd).await?;
        let scale = lockdown
            .get_value(Some("ScreenScaleFactor"), Some("com.apple.mobile.iTunes"))
            .await?;
        let properties = ["DeviceName", "ProductType", "ProductVersion"]
            .into_iter()
            .filter_map(|key| rsd.properties.get(key).map(|value| (key, value)))
            .collect::<std::collections::HashMap<_, _>>();
        return Ok(json!({"scale":scale,"properties":properties}));
    }
    if matches!(request, Request::ListApps) {
        return apps::list(adapter, rsd, provider).await;
    }
    if let Request::Configuration { method, value } = request {
        return configuration::execute(adapter, rsd, &method, value).await;
    }
    if let Request::AxTree { include_offscreen, timeout_ms, event_stream } = request {
        let wait = Duration::from_millis(timeout_ms);
        if event_stream { return ax::read_streamed(adapter, rsd, observer, include_offscreen, wait).await; }
        return ax::read_tree_with_timeout(adapter, rsd, include_offscreen, wait).await;
    }
    if let Request::AppForPid { pid } = request {
        return apps::app_for_pid(adapter, rsd, pid).await;
    }
    if let Request::Pasteboard { action, text } = request {
        return device_ops::pasteboard(adapter, rsd, &action, text.as_deref()).await;
    }
    if matches!(request, Request::DisplayInfo) {
        let mut display =
            idevice::core_device::DisplayServiceClient::connect_rsd(adapter, rsd).await?;
        let info = display.get_media_support_info().await?;
        return Ok(serde_json::to_value(info)?);
    }
    if media.is_none() {
        *media = Some(
            InputMedia::connect(adapter, rsd)
                .await
                .map_err(not_sent_error)?,
        );
    }
    tokio::time::sleep_until(media.as_ref().unwrap().ready_at).await;
    trace("input media ready");
    // The device sometimes drops a touch whose connection closes straight after its last report, with no
    // error. The touch connection therefore stays open through the wait that follows the action;
    // NATIVE.md has the counts.
    let mut touch_reused = false;
    let mut keyboard_reused = false;
    let action: Result<Value> = async {
        match request {
            Request::DisplayInfo
            | Request::DeviceInfo
            | Request::Screenshot { .. }
            | Request::ListApps
            | Request::InstallApp { .. }
            | Request::UninstallApp { .. }
            | Request::AxTree { .. }
            | Request::AppForPid { .. }
            | Request::Pasteboard { .. }
            | Request::Configuration { .. }
            | Request::LaunchApp(_)
            | Request::OpenUrl { .. } => {
                unreachable!()
            }
            Request::Tap { x, y, duration_ms } | Request::LongPress { x, y, duration_ms } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::TapSequence { points, duration_ms, interval_ms } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                let begun = std::time::Instant::now();
                for (index, point) in points.iter().enumerate() {
                    if let Err(error) = held_tap(hid, point.x, point.y, duration_ms).await {
                        // Earlier complete reports are not replayed. The failing
                        // report may have reached iOS even if transport failed.
                        return Ok(json!({"isError":true,"outcome":"unknown","stop_reason":"unknown",
                            "completed_taps":index,"uncertain_tap":index+1,"error":error.to_string(),
                            "screen_change_verified":false,"instruction":"Inspect before any further input; never replay this sequence."}));
                    }
                    if index + 1 < points.len() { tokio::time::sleep(Duration::from_millis(interval_ms)).await; }
                }
                return Ok(json!({"sent":true,"completed_taps":points.len(),"screen_change_verified":false,
                    "sequence_elapsed_ms":begun.elapsed().as_millis() as u64}));
            }
            Request::DoubleTap { x, y, duration_ms } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                held_tap(hid, x, y, duration_ms).await?;
                tokio::time::sleep(Duration::from_millis(80)).await;
                held_tap(hid, x, y, duration_ms).await?;
            }
            Request::Drag {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
                hold_ms,
                end_hold_ms,
            } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                Drag {
                    x1,
                    y1,
                    x2,
                    y2,
                    duration_ms,
                    hold_ms,
                    end_hold_ms,
                }
                .send(hid)
                .await?;
            }
            Request::Pinch {
                x,
                y,
                start_distance,
                end_distance,
                angle,
                duration_ms,
            } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                Pinch {
                    x,
                    y,
                    start_distance,
                    end_distance,
                    angle,
                    duration_ms,
                }
                .send(hid)
                .await?;
            }
            Request::DrawStrokes { strokes } => {
                let (hid, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().touch, || async {
                    Touch::connect_rsd(adapter, rsd).await.map_err(not_sent_error)
                }).await?;
                touch_reused = reused;
                let begun = std::time::Instant::now();
                strokes.send(hid).await?;
                return Ok(json!({
                    "sent": true,
                    "screen_change_verified": false,
                    "strokes": strokes.0.len(),
                    "elapsed_ms": begun.elapsed().as_millis() as u64,
                }));
            }
            Request::Key {
                key,
                modifiers,
                count,
            } => {
                let (keyboard, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().keyboard, || Keyboard::connect(adapter, rsd)).await?;
                keyboard_reused = reused;
                let usages = modifiers
                    .iter()
                    .map(|m| modifier_usage(m))
                    .collect::<Result<Vec<_>>>()?;
                let outcome: Result<()> = async {
                    for _ in 0..count {
                        chord(keyboard, key_usage(&key)?, &usages).await?;
                    }
                    Ok(())
                }
                .await;
                outcome?;
            }
            Request::Button {
                button,
                count,
                interval_ms,
            } => {
                let mut keyboard = Indigo::connect_rsd(adapter, rsd)
                    .await
                    .map_err(not_sent_error)?;
                let (code, duration) = button_usage(&button)?;
                for index in 0..count {
                    if index > 0 {
                        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
                    }
                    keyboard.send_button(0x0c, code, ButtonState::Down).await?;
                    tokio::time::sleep(Duration::from_millis(duration)).await;
                    keyboard.send_button(0x0c, code, ButtonState::Up).await?;
                }
            }
            Request::TypeKeys { text, clear } => {
                let mut keyboard = Keyboard::connect(adapter, rsd).await?;
                let outcome = type_keys(&mut keyboard, &text, clear).await;
                let cleanup = keyboard.close().await;
                outcome?;
                cleanup?;
            }
            Request::TypeText {
                text,
                clear,
                submit,
                target,
            } => {
                let (keyboard, reused) = session_input::cached_channel(&mut media.as_mut().unwrap().keyboard, || Keyboard::connect(adapter, rsd)).await?;
                keyboard_reused = reused;
                let outcome = pasteboard::paste_text(
                    adapter,
                    rsd,
                    keyboard,
                    &text,
                    clear,
                    submit,
                    target.as_ref(),
                )
                .await;
                return outcome;
            }
        }
        Ok(json!({"sent":true,"screen_change_verified":false}))
    }
    .await;
    if let Some(observer) = observer.as_mut() { observer.invalidate(); }
    tokio::time::sleep(Duration::from_millis(300)).await;
    if action.as_ref().is_err() || action.as_ref().is_ok_and(|v| v["isError"] == true) {
        let _ = close_input(media).await;
    }
    action.map(|mut value| {
        value["native_input"] = json!({"touch_reused":touch_reused,"keyboard_reused":keyboard_reused,"idle_release_ms":5000,"delivery_hold_ms":300});
        value
    })
    })
    .await
}

async fn held_tap(hid: &mut Touch, x: u16, y: u16, ms: u64) -> Result<()> {
    hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y, None)
        .await?;
    tokio::time::sleep(Duration::from_millis(ms)).await;
    hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, None)
        .await?;
    Ok(())
}

fn modifier_usage(name: &str) -> Result<u64> {
    Ok(match name.to_ascii_lowercase().as_str() {
        "command" | "cmd" | "meta" => 0xe3,
        "control" | "ctrl" => 0xe0,
        "option" | "alt" => 0xe2,
        "shift" => 0xe1,
        _ => return Err(format!("Unknown modifier: {name}").into()),
    })
}

fn key_usage(name: &str) -> Result<u64> {
    let name = name.to_ascii_lowercase();
    Ok(match name.as_str() {
        "return" | "enter" => 0x28,
        "escape" | "esc" => 0x29,
        "backspace" | "delete" => 0x2a,
        "tab" => 0x2b,
        "space" => 0x2c,
        "forward_delete" => 0x4c,
        "right" | "arrowright" => 0x4f,
        "left" | "arrowleft" => 0x50,
        "down" | "arrowdown" => 0x51,
        "up" | "arrowup" => 0x52,
        "home" => 0x4a,
        "end" => 0x4d,
        "pageup" | "page_up" => 0x4b,
        "pagedown" | "page_down" => 0x4e,
        "capslock" | "caps_lock" => 0x39,
        "0" => 0x27,
        name if name.len() == 1 && name.as_bytes()[0].is_ascii_lowercase() => {
            4 + (name.as_bytes()[0] - b'a') as u64
        }
        name if name.len() == 1 && matches!(name.as_bytes()[0], b'1'..=b'9') => {
            0x1e + (name.as_bytes()[0] - b'1') as u64
        }
        name if name.starts_with('f')
            && name[1..]
                .parse::<u64>()
                .is_ok_and(|v| (1..=12).contains(&v)) =>
        {
            0x39 + name[1..].parse::<u64>()?
        }
        name if name.starts_with("0x") => {
            let usage = u64::from_str_radix(&name[2..], 16)?;
            if usage > 0xff {
                return Err("HID keyboard usage exceeds 255".into());
            }
            usage
        }
        _ => return Err(format!("Unknown keyboard key: {name}").into()),
    })
}

/// The US-layout key, and whether it takes shift, that types one character.
fn char_usage(c: char) -> Result<(u64, bool)> {
    Ok(match c {
        'a'..='z' => (4 + (c as u64 - 'a' as u64), false),
        'A'..='Z' => (4 + (c as u64 - 'A' as u64), true),
        '1'..='9' => (0x1e + (c as u64 - '1' as u64), false),
        '0' => (0x27, false),
        '\n' => (0x28, false),
        '\t' => (0x2b, false),
        ' ' => (0x2c, false),
        '!' => (0x1e, true),
        '@' => (0x1f, true),
        '#' => (0x20, true),
        '$' => (0x21, true),
        '%' => (0x22, true),
        '^' => (0x23, true),
        '&' => (0x24, true),
        '*' => (0x25, true),
        '(' => (0x26, true),
        ')' => (0x27, true),
        '-' => (0x2d, false),
        '_' => (0x2d, true),
        '=' => (0x2e, false),
        '+' => (0x2e, true),
        '[' => (0x2f, false),
        '{' => (0x2f, true),
        ']' => (0x30, false),
        '}' => (0x30, true),
        '\\' => (0x31, false),
        '|' => (0x31, true),
        ';' => (0x33, false),
        ':' => (0x33, true),
        '\'' => (0x34, false),
        '"' => (0x34, true),
        '`' => (0x35, false),
        '~' => (0x35, true),
        ',' => (0x36, false),
        '<' => (0x36, true),
        '.' => (0x37, false),
        '>' => (0x37, true),
        '/' => (0x38, false),
        '?' => (0x38, true),
        _ => return Err(format!("type_keys cannot type {c:?}; use type_text").into()),
    })
}

/// Presses the keys for `text` back to back on one keyboard session (POKI_TYPE_KEY_MS between
/// reports, default 12), after Command-A and Delete when `clear` is set. No settle per character.
async fn type_keys(keyboard: &mut Keyboard, text: &str, clear: bool) -> Result<()> {
    if clear {
        chord(keyboard, 0x04, &[0xe3]).await?;
        chord(keyboard, 0x2a, &[]).await?;
    }
    let gap = hid_wait("POKI_TYPE_KEY_MS", 12);
    let shift = KeyboardUsage::new(0xe1)?;
    let result: Result<()> = async {
        for c in text.chars() {
            let (usage, shifted) = char_usage(c)?;
            let key = KeyboardUsage::new(usage as u16)?;
            if shifted {
                keyboard
                    .hid
                    .main_keyboard_key_down(&mut keyboard.service, shift)
                    .await?;
            }
            keyboard
                .hid
                .main_keyboard_key_down(&mut keyboard.service, key)
                .await?;
            tokio::time::sleep(gap).await;
            keyboard
                .hid
                .main_keyboard_key_up(&mut keyboard.service, key)
                .await?;
            if shifted {
                keyboard
                    .hid
                    .main_keyboard_key_up(&mut keyboard.service, shift)
                    .await?;
            }
            tokio::time::sleep(gap).await;
        }
        Ok(())
    }
    .await;
    let release_error = keyboard
        .hid
        .set_main_keyboard_usages(&mut keyboard.service, [])
        .await
        .err();
    result?;
    if let Some(error) = release_error {
        return Err(error.into());
    }
    Ok(())
}

/// A wait between HID reports, from an environment variable (0..10000 ms) or the default.
fn hid_wait(name: &str, default_ms: u64) -> Duration {
    Duration::from_millis(
        std::env::var(name)
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|ms| *ms <= 10000)
            .unwrap_or(default_ms),
    )
}

fn button_usage(name: &str) -> Result<(u64, u64)> {
    Ok(match name.replace('_', "-").as_str() {
        "home" => (0x40, 80),
        "power" | "lock" | "sleep" => (0x30, 200),
        "volume-up" => (0xe9, 80),
        "volume-down" => (0xea, 80),
        "mute" => (0xe2, 80),
        "siri" => (0xcf, 1200),
        "keyboard" => (0xb8, 80),
        _ => return Err(format!("Unknown hardware button: {name}").into()),
    })
}

async fn chord(keyboard: &mut Keyboard, key: u64, modifiers: &[u64]) -> Result<()> {
    let pressed = modifiers
        .iter()
        .map(|&v| KeyboardUsage::new(v as u16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let key = KeyboardUsage::new(key as u16)?;
    let result: Result<()> = async {
        for usage in &pressed {
            keyboard
                .hid
                .main_keyboard_key_down(&mut keyboard.service, *usage)
                .await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        keyboard
            .hid
            .main_keyboard_key_down(&mut keyboard.service, key)
            .await?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        keyboard
            .hid
            .main_keyboard_key_up(&mut keyboard.service, key)
            .await?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok(())
    }
    .await;
    let release_error = keyboard
        .hid
        .set_main_keyboard_usages(&mut keyboard.service, [])
        .await
        .err();
    result?;
    if let Some(error) = release_error {
        return Err(error.into());
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}

#[cfg(test)]
mod speed_tests;
