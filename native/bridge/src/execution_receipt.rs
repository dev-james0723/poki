//! Native handler receipts for comparing work on the same host and boot.
//!
//! The span starts immediately before polling `execute_connected`'s body and
//! ends when that body returns. It includes awaited I/O and delivery holds;
//! it does not measure iOS execution, contact duration, or socket queueing.
//! A cancelled/failed handler or unavailable monotonic clock supplies no span.

use serde_json::{Value, json};
use std::future::Future;

const FEATURE: &str = "native_execution_v1";
const BUILD_ID: &str = match option_env!("POKI_BUILD_ID") {
    Some(value) => value,
    None => "unversioned",
};

fn monotonic_ns() -> Option<u64> {
    let mut stamp = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // CLOCK_MONOTONIC has a common origin across helper processes on one host.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut stamp) } != 0 {
        return None;
    }
    if !(0..1_000_000_000).contains(&stamp.tv_nsec) {
        return None;
    }
    u64::try_from(stamp.tv_sec).ok()?
        .checked_mul(1_000_000_000)?
        .checked_add(u64::try_from(stamp.tv_nsec).ok()?)
}

fn attach_span(
    mut output: Value,
    operation_id: String,
    started_ns: Option<u64>,
    finished_ns: Option<u64>,
) -> Value {
    if let (Some(start), Some(finish), Some(object)) =
        (started_ns, finished_ns, output.as_object_mut())
    {
        if finish >= start {
            object.insert("native_execution".into(), json!({
                "schema_version": 1,
                "operation_id": operation_id,
                "pid": std::process::id(),
                "clock": "CLOCK_MONOTONIC",
                "scope": "execute_connected",
                // Strings preserve nanoseconds beyond JavaScript's safe integer range.
                "started_ns": start.to_string(),
                "finished_ns": finish.to_string(),
            }));
        }
    }
    output
}

pub async fn measure<F>(future: F) -> crate::Result<Value>
where
    F: Future<Output = crate::Result<Value>>,
{
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started_ns = monotonic_ns();
    let result = future.await;
    let finished_ns = monotonic_ns();
    result.map(|output| attach_span(output, operation_id, started_ns, finished_ns))
}

/// This path inspects the candidate executable without opening any device.
pub fn build_info() -> Value {
    json!({"native_runtime": {
        "pid": std::process::id(),
        "build_id": BUILD_ID,
        "version": env!("CARGO_PKG_VERSION"),
        "features": [FEATURE],
    }})
}

/// Bind response metadata to the session's selected device, never request data.
/// Existing runtime capabilities are retained for compatibility with newer builds.
pub fn with_runtime(mut output: Value, device: &str) -> Value {
    let Some(object) = output.as_object_mut() else {
        return output;
    };
    let mut runtime = object.get("native_runtime")
        .and_then(Value::as_object).cloned().unwrap_or_default();
    runtime.insert("pid".into(), json!(std::process::id()));
    runtime.insert("build_id".into(), json!(BUILD_ID));
    runtime.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
    runtime.insert("device".into(), json!(device));
    let features = runtime.entry("features").or_insert_with(|| json!([]));
    if !features.is_array() {
        *features = json!([]);
    }
    let features = features.as_array_mut().expect("features is an array");
    if !features.iter().any(|value| value.as_str() == Some(FEATURE)) {
        features.push(json!(FEATURE));
    }
    object.insert("native_runtime".into(), Value::Object(runtime));
    if let Some(span) = object.get_mut("native_execution").and_then(Value::as_object_mut) {
        span.insert("device".into(), json!(device));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(span: &Value, key: &str) -> u64 {
        span[key].as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn nanoseconds_are_lossless_strings_and_invalid_clocks_omit_evidence() {
        let base = json!({"sent": true, "verified": false});
        let beyond_js_precision = 9_007_199_254_740_993;
        let measured = attach_span(base.clone(), "op".into(),
            Some(beyond_js_precision), Some(beyond_js_precision + 1));
        assert_eq!(measured["native_execution"]["started_ns"], "9007199254740993");
        assert_eq!(measured["sent"], true);
        assert_eq!(measured["verified"], false);
        for (start, end) in [(None, Some(1)), (Some(1), None), (Some(2), Some(1))] {
            assert_eq!(attach_span(base.clone(), "op".into(), start, end), base);
        }
    }

    #[tokio::test]
    async fn measure_preserves_success_and_error_semantics() {
        let output = measure(async { Ok(json!({"sent": true})) }).await.unwrap();
        let span = &output["native_execution"];
        assert_eq!(output["sent"], true);
        assert_eq!(span["clock"], "CLOCK_MONOTONIC");
        assert_eq!(span["scope"], "execute_connected");
        assert!(time(span, "finished_ns") >= time(span, "started_ns"));
        uuid::Uuid::parse_str(span["operation_id"].as_str().unwrap()).unwrap();
        let error = measure(async { Err("original failure".into()) }).await.unwrap_err();
        assert_eq!(error.to_string(), "original failure");
    }

    #[tokio::test]
    async fn concurrent_handlers_report_intersecting_monotonic_spans() {
        let barrier = tokio::sync::Barrier::new(2);
        let work = || async {
            barrier.wait().await;
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            Ok(json!({"sent": true}))
        };
        let (first, second) = tokio::join!(measure(work()), measure(work()));
        let (first, second) = (first.unwrap(), second.unwrap());
        let (a, b) = (&first["native_execution"], &second["native_execution"]);
        assert_ne!(a["operation_id"], b["operation_id"]);
        let start = time(a, "started_ns").max(time(b, "started_ns"));
        let end = time(a, "finished_ns").min(time(b, "finished_ns"));
        assert!(end > start, "the two joined native handler futures overlapped");
    }

    #[test]
    fn runtime_identity_keeps_existing_capabilities_and_binds_session_device() {
        let base = json!({
            "sent": true,
            "native_runtime": {"features": ["warm_hid"], "extension": "kept"},
            "native_execution": {"device": "untrusted"},
        });
        let output = with_runtime(with_runtime(base, "session-device"), "session-device");
        assert_eq!(output["sent"], true);
        assert_eq!(output["native_runtime"]["features"], json!(["warm_hid", FEATURE]));
        assert_eq!(output["native_runtime"]["extension"], "kept");
        assert_eq!(output["native_runtime"]["device"], "session-device");
        assert_eq!(output["native_execution"]["device"], "session-device");
        assert_eq!(output["native_runtime"]["build_id"], BUILD_ID);
        assert_eq!(build_info()["native_runtime"]["build_id"], BUILD_ID);
    }
}
