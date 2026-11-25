'use strict';

/*
 * crop-refresh.js - keeps a live run's window crop current (row 197). The crop is the window's client area as
 * fractions of its drawn bounds, read from the helper's window.geometry; the panel shows only that part.
 *
 * One lookup at a time per run: a change while one is out asks once more when it answers. A minimized window, a
 * failed lookup or a reply that does not add up keeps the crop the run had (the run state is never touched); an
 * answer for a window or generation that is gone is dropped. Pure apart from the request it is given.
 */

const { cropOf } = require('./helper-replies');
const { isLive } = require('./run-state');

const cropWanted = (r) => r.state.hwnd !== null && isLive(r.state) && r.state.state !== 'minimized';

// request(op, args) -> Promise (the helper), warn(message, error), onCrop(record, projectId) after a new crop.
// The record carries `crop`, `cropBusy` and `cropAgain`; the run service clears `crop` when the window changes.
function createCropRefresh({ request, warn, onCrop }) {
  return async function refreshCrop(r, projectId) {
    if (!cropWanted(r)) return;
    if (r.cropBusy) { r.cropAgain = true; return; }
    r.cropBusy = true;
    try {
      do {
        r.cropAgain = false;
        const { generation, hwnd } = r.state;
        let crop = null;
        try {
          const reply = await request('window.geometry', { hwnd });
          crop = reply?.minimized === true ? null : cropOf(reply);
        } catch (error) {
          warn('window.geometry failed', error);
        }
        if (crop && r.state.generation === generation && r.state.hwnd === hwnd && cropWanted(r)) {
          r.crop = crop;
          onCrop(r, projectId);
        }
      } while (r.cropAgain && cropWanted(r));
    } finally {
      r.cropBusy = false;
    }
  };
}

module.exports = { createCropRefresh };
