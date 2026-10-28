/* renderer/features/renderer-ide-pdf-save-state.js - annotation dirty
 * tracking and export for the Workspace IDE PDF pane (renderer-ide-pdf-host.js).
 * Dirty compares pdf.js's serializable hash (exactly what saveDocument writes)
 * against the hash the last landed export wrote. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfSaveState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // deps: isLive(record) (still the pane's committed record), onEdit(path),
  // setDirty(path, dirty), log(level, event, fields).
  function createPdfSaveState({ isLive, onEdit, setDirty, log }) {
    // pdf.js hashes exactly what saveDocument would write ('' when nothing
    // would be written), and an unchanged existing annotation serializes to
    // null, so entering an edit mode (which loads existing annotations into
    // storage) is not an edit. null when the storage has no serializable view.
    function storageHash(record) {
      try {
        const serializable = record.pdfDocument.annotationStorage.serializable;
        // Stamp bitmaps are cloned for the caller to transfer; release them.
        for (const bitmap of serializable?.transfer || []) bitmap?.close?.();
        const hash = serializable?.hash;
        return typeof hash === 'string' ? hash : null;
      } catch (error) {
        log('warn', 'ide.pdf.storage_hash_failed', { path: record.path, message: String(error?.message || error) });
        return null;
      }
    }

    function check(record, notified) {
      if (record.destroyed || !isLive(record)) return;
      const hash = storageHash(record);
      if (hash === null) {
        if (notified) {
          onEdit(record.path);
          setDirty(record.path, true);
        }
        return;
      }
      if (hash === record.seenHash) return;
      record.seenHash = hash;
      onEdit(record.path);
      setDirty(record.path, hash !== record.savedHash);
    }

    // pdf.js mutates annotations already in storage in place (move, resize,
    // recolor, re-edit) and AnnotationStorage.remove() never notifies, so the
    // pane re-checks the hash after editing gestures. Deferred to a task so
    // pdf.js's own listeners for the same event have run.
    function schedule(record) {
      if (record.storageCheckQueued || record.destroyed) return;
      record.storageCheckQueued = true;
      globalRef.setTimeout(() => {
        record.storageCheckQueued = false;
        check(record, false);
      }, 0);
    }

    // A page gesture can change annotations only while an editor mode is on
    // or once storage holds values (form fields, earlier edits): reading a
    // PDF never pays for serializing its storage on every click and key.
    function scheduleAfterGesture(record) {
      if (record.state?.editorMode !== 'none' || record.pdfDocument?.annotationStorage?.size > 0) schedule(record);
    }

    function track(record) {
      record.savedHash = record.seenHash = storageHash(record);
      // Dirty is owned here, never by pdf.js: saveDocument() calls
      // resetModified() in its finally, long before main has landed the
      // bytes, so pdf.js's onResetModified must not clear the pane's dirty
      // state. markSaved (after a landed write) is the only path that clears it.
      record.pdfDocument.annotationStorage.onSetModified = () => {
        // pdf.js emits only on the clean -> modified transition. Re-arm its
        // notification latch synchronously so edits during export/write also
        // advance Jenny's save fence. This does not remove stored annotations.
        // Runs inside pdf.js setValue: a throw here would abort the edit.
        try {
          record.pdfDocument.annotationStorage.resetModified();
          check(record, true);
        } catch (error) {
          log('warn', 'ide.pdf.edit_tracking_failed', { path: record.path, message: String(error?.message || error) });
        }
      };
    }

    function markSaved(record) {
      record.pdfDocument.annotationStorage.resetModified();
      // The baseline is what the export wrote; a change pdf.js never
      // announced after that export is re-detected by the check.
      record.savedHash = record.seenHash = record.exportedHash ?? storageHash(record);
      record.exportedHash = null;
      setDirty(record.path, false);
      schedule(record);
    }

    async function exportData(record) {
      const hash = storageHash(record);
      record.exportedHash = hash;
      // Nothing to write: getData() returns the loaded bytes instead of
      // saveDocument() walking every page in the worker.
      const untouched = hash === null ? record.pdfDocument.annotationStorage.size === 0 : hash === '';
      return untouched ? record.pdfDocument.getData() : record.pdfDocument.saveDocument();
    }

    return { check, exportData, markSaved, schedule, scheduleAfterGesture, track };
  }

  return { createPdfSaveState };
});
