use super::*;
use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};

#[tokio::test(start_paused=true)]
async fn completed_ax_tree_survives_a_stalled_cleanup_and_drops_it() {
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard { fn drop(&mut self) { self.0.fetch_add(1, Ordering::SeqCst); } }
    let dropped=Arc::new(AtomicUsize::new(0));let d=dropped.clone();
    let start=tokio::time::Instant::now();
    let result=ax::finish_subscription(Ok(json!({"elements":[]})), async move {
        let _guard=Guard(d);std::future::pending::<()>().await;
    }).await.unwrap();
    assert_eq!(result,json!({"elements":[]}));
    assert_eq!(dropped.load(Ordering::SeqCst),1);
    assert_eq!(start.elapsed(),Duration::from_millis(100));
    let error=ax::finish_subscription::<()>(Err("original read error".into()),async{}).await.unwrap_err();
    assert_eq!(error.to_string(),"original read error");
}

#[test]
fn native_tap_sequence_validates_the_whole_request_before_dispatch() {
    for length in [0,1,9] {
        let points=vec![json!({"x":100,"y":200});length];
        let r:Request=serde_json::from_value(json!({"op":"tap_sequence","points":points})).unwrap();
        assert!(r.validate().is_err());
    }
    for (duration,interval) in [(29,50),(151,50),(50,29),(50,251)] {
        let r:Request=serde_json::from_value(json!({"op":"tap_sequence","points":[{"x":100,"y":200},{"x":300,"y":400}],"duration_ms":duration,"interval_ms":interval})).unwrap();
        assert!(r.validate().is_err());
    }
    let valid:Request=serde_json::from_value(json!({"op":"tap_sequence","points":[{"x":0,"y":0},{"x":65535,"y":65535}]})).unwrap();
    assert!(valid.validate().is_ok());
    assert!(!valid.read_only());
    assert!(serde_json::from_value::<Request>(json!({"op":"tap_sequence","points":[{"x":-1,"y":0},{"x":2,"y":3}]})).is_err());
    assert!(serde_json::from_value::<Request>(json!({"op":"tap_sequence","points":[{"x":1,"y":0,"extra":true},{"x":2,"y":3}]})).is_err());
}

#[tokio::test]
async fn warm_channel_connects_once_until_explicit_invalidation() {
    let count=Arc::new(AtomicUsize::new(0));let mut slot:Option<usize>=None;
    for expected_reused in [false,true,true] {
        let n=count.clone();
        let (channel,reused)=session_input::cached_channel(&mut slot,||async move {Ok(n.fetch_add(1,Ordering::SeqCst)+1)}).await.unwrap();
        assert_eq!(*channel,1);assert_eq!(reused,expected_reused);
    }
    assert_eq!(count.load(Ordering::SeqCst),1);
    slot=None;let n=count.clone();
    let (channel,reused)=session_input::cached_channel(&mut slot,||async move {Ok(n.fetch_add(1,Ordering::SeqCst)+1)}).await.unwrap();
    assert_eq!(*channel,2);assert!(!reused);
}
#[tokio::test]
async fn failed_channel_connection_is_not_cached_or_replayed() {
    let count=AtomicUsize::new(0);let mut slot:Option<usize>=None;
    let result=session_input::cached_channel(&mut slot,||async {count.fetch_add(1,Ordering::SeqCst);Err("connection failed".into())}).await;
    assert!(result.is_err());assert!(slot.is_none());assert_eq!(count.load(Ordering::SeqCst),1);
}
#[tokio::test(start_paused=true)]
async fn ax_budget_covers_and_drops_the_entire_pending_subscription() {
    struct Guard(Arc<AtomicUsize>);impl Drop for Guard {fn drop(&mut self){self.0.fetch_add(1,Ordering::SeqCst);}}
    let dropped=Arc::new(AtomicUsize::new(0));let d=dropped.clone();
    let start=tokio::time::Instant::now();
    let result=ax::within_budget(Duration::from_millis(250),async move {
        let _guard=Guard(d);std::future::pending::<Result<()>>().await
    }).await;
    assert!(result.is_err());assert_eq!(dropped.load(Ordering::SeqCst),1);
    assert!(start.elapsed()<=Duration::from_millis(251));
}
#[test]
fn ax_timeout_is_validated_at_the_native_boundary() {
    for ms in [0,20001] {
        let r:Request=serde_json::from_value(json!({"op":"ax_tree","timeout_ms":ms})).unwrap();
        assert!(r.validate().is_err());
    }
    let r:Request=serde_json::from_value(json!({"op":"ax_tree","timeout_ms":1250})).unwrap();assert!(r.validate().is_ok());
}
#[tokio::test(start_paused=true)]
async fn abandoned_ax_read_drops_only_its_private_channel() {
    struct Guard(Arc<AtomicUsize>);impl Drop for Guard {fn drop(&mut self){self.0.fetch_add(1,Ordering::SeqCst);}}
    let dropped=Arc::new(AtomicUsize::new(0));let d=dropped.clone();
    let reading=async move {let _g=Guard(d);std::future::pending::<usize>().await};
    let disconnect=async {tokio::time::sleep(Duration::from_millis(100)).await};
    let result=remote::cancellable_read(reading,disconnect).await;
    assert!(result.is_none());assert_eq!(dropped.load(Ordering::SeqCst),1);
}

#[tokio::test(start_paused=true)]
async fn ax_event_cache_requires_a_recent_post_invalidation_event() {
    let start=tokio::time::Instant::now();
    assert!(ax::event_is_fresh(start,start,Duration::from_millis(500)));
    tokio::time::advance(Duration::from_millis(501)).await;
    assert!(!ax::event_is_fresh(start,start,Duration::from_millis(500)));
    let now=tokio::time::Instant::now();
    assert!(!ax::event_is_fresh(start,now,Duration::from_secs(2)));
    assert!(ax::event_is_fresh(now,now,Duration::from_millis(500)));
}
