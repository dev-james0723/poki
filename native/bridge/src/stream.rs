// Source: jkcoxson/idevice tools/src/coredevice_stream.rs at 8970209; MIT license.
// Jackson Coxson
//
// Shared helper for bringing up a CoreDevice screen media stream over the
// displayservice. Used by `screencapture` (to receive the video) and by `hid`
// (to hold open dtuhidd's authentication gate while sending touch reports — the
// RTP payload is discarded there).

use idevice::{
    IdeviceError, ReadWrite, RsdService,
    core_device::{
        CallInfoBlob, DisplayServiceClient, build_screen_audio_offer, build_screen_video_offer,
        build_start_audio_parameters, build_start_video_parameters,
    },
    rsd::RsdHandshake,
    tcp::handle::{AdapterHandle, UdpSocketHandle},
};

/// `clientSupportedFeatures` is what *we* (the controller) support, NOT the
/// device's mask. Device Hub sends 140 for screen sharing; sending the device's
/// larger mask makes the negotiator produce an invalid video config.
const CLIENT_SUPPORTED_FEATURES: u64 = 140;

/// An active screen media stream and the UDP sockets the device sends RTP to.
pub struct ScreenMediaStream {
    pub client: DisplayServiceClient<Box<dyn ReadWrite>>,
    /// Audio RTP receiver socket (kept bound for the lifetime of the stream).
    pub audio_udp: Option<UdpSocketHandle>,
    /// Video RTP receiver socket — the HEVC stream.
    pub video_udp: UdpSocketHandle,
}

/// The phone offers no displayservice, which input needs. A developer disk image provides it.
#[derive(Debug)]
pub struct NoDisplayService;
impl std::fmt::Display for NoDisplayService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cannot establish input media session: no display service: ServiceNotFound")
    }
}
impl std::error::Error for NoDisplayService {}

/// Connect the displayservice and start the audio+video screen-sharing session.
///
/// Mirrors what Device Hub does: an audio stream is started first to establish
/// the screen-sharing session, then video on the same `clientSessionID`. All
/// On error returns a human-readable message. Endpoint logging is disabled.
pub async fn start_screen_media_stream(
    adapter: &mut AdapterHandle,
    handshake: &mut RsdHandshake,
    display_id: i64,
) -> Result<ScreenMediaStream, Box<dyn std::error::Error + Send + Sync>> {
    start_media_stream(adapter, handshake, display_id, true).await
}

/// HID authentication needs the video session, not screen audio. Avoid an
/// unrelated audio negotiation and receiver on ordinary touch/keyboard input.
pub async fn start_input_media_stream(
    adapter: &mut AdapterHandle,
    handshake: &mut RsdHandshake,
    display_id: i64,
) -> Result<ScreenMediaStream, Box<dyn std::error::Error + Send + Sync>> {
    start_media_stream(adapter, handshake, display_id, false).await
}

async fn start_media_stream(
    adapter: &mut AdapterHandle,
    handshake: &mut RsdHandshake,
    display_id: i64,
    audio: bool,
) -> Result<ScreenMediaStream, Box<dyn std::error::Error + Send + Sync>> {
    macro_rules! log {
        ($($arg:tt)*) => {{}};
    }

    let mut client = DisplayServiceClient::connect_rsd(adapter, handshake)
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
            match e {
                IdeviceError::ServiceNotFound => Box::new(NoDisplayService),
                // Keep the io type: remote.rs probes the tunnel after a socket failure.
                IdeviceError::Socket(e) => Box::new(std::io::Error::new(
                    e.kind(),
                    format!("no display service: {e}"),
                )),
                e => format!("no display service: {e:?}").into(),
            }
        })?;

    let audio_udp = if audio { Some(adapter
        .bind_udp(0)
        .await
        .map_err(|e| format!("bind_udp(audio) failed: {e:?}"))?) } else { None };
    let video_udp = adapter
        .bind_udp(0)
        .await
        .map_err(|e| format!("bind_udp(video) failed: {e:?}"))?;
    let receiver_ip = adapter.host_ip().to_string();
    let receiver_port = video_udp.local_port();
    // The device is the sender; the host (controller) assigns its endpoint too.
    let sender_ip = adapter.peer_ip().to_string();
    log!("video receiver = {receiver_ip}:{receiver_port}, sender = {sender_ip}");

    // VCCallInfoBlob describing this (host) endpoint. The string values mirror a
    // captured Device Hub offer the device accepted.
    let call_info = CallInfoBlob {
        call_id: 0,
        client_version: 1,
        device_type: "Mac17,7".into(),
        framework_version: "2205.3.1".into(),
        os_version: "25F71".into(),
        device_name: None,
        audio_device_uid: None,
    };

    // The screen-sharing session is keyed by clientSessionID; both the audio and
    // video streams share it.
    let client_session_id = uuid::Uuid::new_v4();

    // Start the audio stream first to establish the screen-sharing session.
    if let Some(audio_udp) = audio_udp.as_ref() {
    let audio_receiver_port = audio_udp.local_port();
    let audio_call_id = uuid::Uuid::new_v4().to_string().to_uppercase();
    let audio_offer = build_screen_audio_offer(&audio_call_id, &call_info)
        .map_err(|e| format!("audio offer build failed: {e:?}"))?;
    let audio_params = build_start_audio_parameters(
        &receiver_ip,
        audio_receiver_port,
        &sender_ip,
        50000,
        audio_offer,
        CLIENT_SUPPORTED_FEATURES,
        client_session_id,
    );
    // Only the video stream holds dtuhidd's authentication gate open (pymobiledevice3 and
    // go-ios start video alone). A refused audio start (seen over RemotePairing from a
    // Windows host) is therefore not fatal; a failed video start below still fails the
    // input, so a touch is never reported as sent without the gate.
    match client.start_media_stream(audio_params).await {
        Ok(_) => log!("audio stream started (session {client_session_id})"),
        Err(_error) => log!("audio stream unavailable ({_error:?}); continuing with video only"),
    }
    }

    // Start the video stream on the same session.
    let call_id = uuid::Uuid::new_v4().to_string().to_uppercase();
    // SSRC declared in the offer (field 5.1); must match the RTCP sender SSRC if
    // sending feedback. This tool doesn't send RTCP, so any value works.
    let our_ssrc = uuid::Uuid::new_v4().as_u128() as u32;
    let offer = build_screen_video_offer(&call_id, &call_info, our_ssrc)
        .map_err(|e| format!("video offer build failed: {e:?}"))?;
    let params = build_start_video_parameters(
        &receiver_ip,
        receiver_port,
        &sender_ip,
        50001,
        offer,
        CLIENT_SUPPORTED_FEATURES,
        display_id,
        client_session_id,
    );
    let _answer = client
        .start_media_stream(params)
        .await
        .map_err(|e| format!("video startMediaStream failed: {e:?}"))?;
    log!("video stream started (session {client_session_id})");

    Ok(ScreenMediaStream {
        client,
        audio_udp,
        video_udp,
    })
}
