//! GGRS (GGPO's rollback, in Rust) for the kinetic host: a session whose
//! socket is two queues the host fills and drains, so the session reaches
//! nothing itself. The host carries the bytes over whatever channel the
//! duel opened, and answers the session's save, load and advance requests
//! with the Jessie engine (omnishell's interpreter/kinetic-session.js).
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use ggrs::{
    Config, DesyncDetection, GgrsError, GgrsEvent, GgrsRequest, InputStatus, Message, NonBlockingSocket, P2PSession, PlayerType,
    PredictRepeatLast, SessionBuilder, SessionState, SyncTestSession,
};
use js_sys::{Array, Function, Uint8Array};
use wasm_bindgen::prelude::*;

struct Cfg;
impl Config for Cfg {
    // A seat's input is one byte: throttle, brake, left, right, drift, nitro.
    type Input = u8;
    type InputPredictor = PredictRepeatLast;
    // The host keeps the snapshots; a cell holds the frame it was saved at.
    type State = i32;
    // One peer.
    type Address = u8;
}

const PEER: u8 = 1;

#[derive(Default)]
struct Queues {
    outgoing: Vec<Vec<u8>>,
    incoming: Vec<Vec<u8>>,
}

struct Channel(Rc<RefCell<Queues>>);

impl NonBlockingSocket<u8> for Channel {
    fn send_to(&mut self, msg: &Message, _addr: &u8) {
        self.0.borrow_mut().outgoing.push(bincode::serialize(msg).expect("a message serializes"));
    }

    // A message that does not decode is no peer of this build's: the trap is
    // the session's failure, which the host makes the page's.
    fn receive_all_messages(&mut self) -> Vec<(u8, Message)> {
        self.0
            .borrow_mut()
            .incoming
            .drain(..)
            .map(|bytes| (PEER, bincode::deserialize(&bytes).expect("a peer's message decodes")))
            .collect()
    }
}

enum Session {
    P2P(P2PSession<Cfg>),
    SyncTest(SyncTestSession<Cfg>),
}

#[wasm_bindgen]
pub struct Rollback {
    session: Session,
    queues: Rc<RefCell<Queues>>,
}

fn fail(err: GgrsError) -> JsError {
    JsError::new(&err.to_string())
}

#[wasm_bindgen]
impl Rollback {
    /// A two-seat session with one peer: `seat` is this side's. A peer
    /// silent for `disconnect_ms` is dropped, and its seat drives nothing.
    pub fn p2p(seat: usize, input_delay: usize, max_prediction: usize, fps: usize, disconnect_ms: u32) -> Result<Rollback, JsError> {
        let queues = Rc::new(RefCell::new(Queues::default()));
        let session = SessionBuilder::<Cfg>::new()
            .with_num_players(2)
            .map_err(fail)?
            .with_input_delay(input_delay)
            .with_max_prediction_window(max_prediction)
            .with_fps(fps)
            .map_err(fail)?
            .with_desync_detection_mode(DesyncDetection::On { interval: 10 })
            .with_disconnect_timeout(Duration::from_millis(disconnect_ms.into()))
            .with_disconnect_notify_delay(Duration::from_millis((disconnect_ms / 4).into()))
            .add_player(PlayerType::Local, seat)
            .map_err(fail)?
            .add_player(PlayerType::Remote(PEER), 1 - seat)
            .map_err(fail)?
            .start_p2p_session(Channel(queues.clone()))
            .map_err(fail)?;
        Ok(Rollback { session: Session::P2P(session), queues })
    }

    /// GGRS's sync test: both seats local, every frame rolled back
    /// `check_distance` frames and re-simulated, checksums held equal.
    pub fn sync_test(check_distance: usize) -> Result<Rollback, JsError> {
        let session = SessionBuilder::<Cfg>::new()
            .with_num_players(2)
            .map_err(fail)?
            .with_check_distance(check_distance)
            .start_synctest_session()
            .map_err(fail)?;
        Ok(Rollback { session: Session::SyncTest(session), queues: Rc::new(RefCell::new(Queues::default())) })
    }

    /// A message the peer sent, for the session's next poll.
    pub fn receive(&self, bytes: &[u8]) {
        self.queues.borrow_mut().incoming.push(bytes.to_vec());
    }

    /// The messages for the peer since the last call.
    pub fn outgoing(&self) -> Array {
        self.queues.borrow_mut().outgoing.drain(..).map(|bytes| JsValue::from(Uint8Array::from(bytes.as_slice()))).collect()
    }

    /// Reads what the peer sent and answers it: synchronisation, inputs, quality reports.
    pub fn poll(&mut self) {
        if let Session::P2P(s) = &mut self.session {
            s.poll_remote_clients();
        }
    }

    pub fn running(&self) -> bool {
        match &self.session {
            Session::P2P(s) => s.current_state() == SessionState::Running,
            Session::SyncTest(_) => true,
        }
    }

    /// How many frames this side runs ahead of the peer; a session that is
    /// ahead skips a frame to let it catch up.
    pub fn frames_ahead(&self) -> i32 {
        match &self.session {
            Session::P2P(s) => s.frames_ahead(),
            Session::SyncTest(_) => 0,
        }
    }

    /// The latest frame every seat's input has arrived for: nothing at or
    /// before it is rolled back again, so it is what a host may lift. A sync
    /// test holds every input here; its host knows how far back it rolls.
    pub fn confirmed_frame(&self) -> i32 {
        match &self.session {
            Session::P2P(s) => s.confirmed_frame(),
            Session::SyncTest(_) => i32::MAX,
        }
    }

    /// The session's events since the last call, as text the host logs or acts on.
    pub fn events(&mut self) -> Array {
        let Session::P2P(s) = &mut self.session else { return Array::new() };
        s.events()
            .map(|event| {
                JsValue::from_str(&match event {
                    GgrsEvent::Synchronizing { count, total, .. } => format!("synchronizing {count}/{total}"),
                    GgrsEvent::Synchronized { .. } => "synchronized".to_string(),
                    GgrsEvent::Disconnected { .. } => "disconnected".to_string(),
                    GgrsEvent::NetworkInterrupted { disconnect_timeout, .. } => format!("interrupted {disconnect_timeout}"),
                    GgrsEvent::NetworkResumed { .. } => "resumed".to_string(),
                    GgrsEvent::WaitRecommendation { skip_frames } => format!("wait {skip_frames}"),
                    GgrsEvent::DesyncDetected { frame, local_checksum, remote_checksum, .. } => {
                        format!("desync {frame} {local_checksum} {remote_checksum}")
                    }
                })
            })
            .collect()
    }

    pub fn add_local_input(&mut self, seat: usize, input: u8) -> Result<(), JsError> {
        match &mut self.session {
            Session::P2P(s) => s.add_local_input(seat, input),
            Session::SyncTest(s) => s.add_local_input(seat, input),
        }
        .map_err(fail)
    }

    /// One frame: the session's requests answered in order by the host's
    /// `save(frame) -> checksum`, `load(frame)` and `advance(inputs, disconnected)`.
    /// False when the session takes no frame yet: still synchronising, or as
    /// far ahead of the peer as it may predict.
    pub fn advance_frame(&mut self, save: &Function, load: &Function, advance: &Function) -> Result<bool, JsError> {
        let requests = match &mut self.session {
            Session::P2P(s) => s.advance_frame(),
            Session::SyncTest(s) => s.advance_frame(),
        };
        let requests = match requests {
            Ok(requests) => requests,
            Err(GgrsError::PredictionThreshold | GgrsError::NotSynchronized) => return Ok(false),
            Err(err) => return Err(fail(err)),
        };
        for request in requests {
            match request {
                GgrsRequest::SaveGameState { cell, frame } => {
                    let checksum = save.call1(&JsValue::NULL, &JsValue::from(frame)).map_err(|e| JsError::new(&format!("save: {e:?}")))?;
                    let checksum = checksum.as_f64().ok_or_else(|| JsError::new("save returned no checksum"))?;
                    cell.save(frame, Some(frame), Some(checksum as u128));
                }
                GgrsRequest::LoadGameState { cell, .. } => {
                    let frame = cell.load().ok_or_else(|| JsError::new("load: the cell holds no frame"))?;
                    load.call1(&JsValue::NULL, &JsValue::from(frame)).map_err(|e| JsError::new(&format!("load: {e:?}")))?;
                }
                GgrsRequest::AdvanceFrame { inputs } => {
                    let bytes: Vec<u8> = inputs.iter().map(|(input, _)| *input).collect();
                    let gone: Vec<u8> = inputs.iter().map(|(_, status)| u8::from(*status == InputStatus::Disconnected)).collect();
                    advance
                        .call2(&JsValue::NULL, &Uint8Array::from(bytes.as_slice()), &Uint8Array::from(gone.as_slice()))
                        .map_err(|e| JsError::new(&format!("advance: {e:?}")))?;
                }
            }
        }
        Ok(true)
    }
}
