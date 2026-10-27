//! Live events (plan 2.3, /events). PostgreSQL delivers each committed change through NOTIFY; this process fans it out
//! to WebSocket connections, checking for each one that the person may see the lead it concerns.

use crate::{
    auth::Ctx,
    error::ApiResult,
    state::{AppState, Event},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use sqlx::postgres::PgListener;

pub fn spawn_listener(state: AppState) {
    tokio::spawn(async move {
        loop {
            match PgListener::connect_with(&state.db).await {
                Ok(mut listener) => {
                    if let Err(error) = listener.listen("turf_events").await {
                        tracing::warn!(%error, "event listener could not subscribe");
                    } else {
                        while let Ok(notification) = listener.recv().await {
                            if let Ok(event) = serde_json::from_str::<Event>(notification.payload()) {
                                let _ = state.events.send(event);
                            }
                        }
                    }
                }
                Err(error) => tracing::warn!(%error, "event listener could not connect"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

pub async fn socket(State(state): State<AppState>, ctx: Ctx, upgrade: WebSocketUpgrade) -> ApiResult<Response> {
    let scope = ctx.scope()?;
    // Echo the protocol a browser that sent its token in the subprotocol list asked for, or it drops the socket.
    Ok(upgrade.protocols([crate::auth::SOCKET_PROTOCOL]).on_upgrade(move |socket| run(socket, state, scope, ctx.access_revision)))
}

async fn run(mut socket: WebSocket, state: AppState, scope: crate::db::Scope, access_revision: i64) {
    let mut events = state.events.subscribe();
    let hello = serde_json::json!({ "kind": "hello", "access_revision": access_revision });
    if socket.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            received = events.recv() => {
                let event = match received {
                    Ok(event) => event,
                    // Missed events: the client resynchronizes from its cursor.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = socket.send(Message::Text(r#"{"kind":"resync"}"#.into())).await;
                        continue;
                    }
                    Err(_) => return,
                };
                if event.org_id != scope.org_id || !may_see(&state, &scope, &event).await {
                    continue;
                }
                if event.kind == "access.changed" {
                    // Permissions changed: the client must re-authorize and pull again before trusting its cache.
                    let _ = socket.send(Message::Text(r#"{"kind":"access.changed"}"#.into())).await;
                    let _ = socket.send(Message::Close(None)).await;
                    return;
                }
                let Ok(text) = serde_json::to_string(&event) else { continue };
                if socket.send(Message::Text(text.into())).await.is_err() {
                    return;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Ping(data))) => { let _ = socket.send(Message::Pong(data)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            }
        }
    }
}

async fn may_see(state: &AppState, scope: &crate::db::Scope, event: &Event) -> bool {
    if event.kind == "access.changed" {
        return true;
    }
    let Some(lead) = event.lead_id else {
        // Organization-level changes (settings, rules) go to people who can see everything.
        return scope.access.sees_all();
    };
    let Ok(mut tx) = crate::db::begin(&state.db, scope).await else { return false };
    let visible: bool = sqlx::query_scalar("SELECT turf_visible_lead($1)").bind(lead).fetch_one(&mut *tx).await.unwrap_or(false);
    let _ = tx.rollback().await;
    visible
}
