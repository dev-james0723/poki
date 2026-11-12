//! Session-scoped service reuse. Reconnection is allowed only before dispatch;
//! callers never replay a request after a send error.
use super::Result;
use std::future::Future;

pub async fn cached_channel<T, F, Fut>(slot: &mut Option<T>, connect: F) -> Result<(&mut T, bool)>
where F: FnOnce() -> Fut, Fut: Future<Output = Result<T>> {
    let reused = slot.is_some();
    if slot.is_none() {
        *slot = Some(connect().await?);
    }
    Ok((slot.as_mut().expect("initialized channel"), reused))
}
