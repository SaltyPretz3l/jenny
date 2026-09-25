'use strict';

function createProjectBrowserService(owner, execution, { signal = null } = {}) {
  if (!owner || !execution || typeof owner.reserveSlot !== 'function') return null;
  const authority = Object.freeze({ ...execution.authority });
  let ownedId = null;
  const assertCurrent = () => {
    execution.assertCurrent();
    if (!authority.root_path || signal?.aborted) throw new Error('Preview authority is unavailable.');
  };
  const assertOwned = id => {
    if (!ownedId || id !== ownedId) throw new Error('Preview session does not belong to this operation.');
  };
  const close = async id => {
    assertOwned(id);
    const result = await owner.close(id);
    if (result?.closed === true || result?.reason === 'not_found') ownedId = null;
    return result;
  };
  const run = async (method, id, options) => {
    assertOwned(id);
    try {
      assertCurrent();
      const result = await owner[method](id, { ...options, abortSignal: signal });
      assertCurrent();
      return result;
    } catch (error) {
      // Close only this operation's producer. The shared owner retains its
      // capacity until its existing close/operation-tail contract settles.
      await close(id).catch(() => null);
      throw error;
    }
  };
  return Object.freeze({
    async open(options = {}) {
      assertCurrent();
      if (ownedId) throw new Error('Preview operation already owns a browser session.');
      const id = options.sessionId;
      const reservation = owner.reserveSlot(id);
      if (reservation?.ok !== true) throw new Error('Preview browser capacity is unavailable.');
      ownedId = id;
      try {
        const result = await owner.open({ ...options, allowedFileRoots: [authority.root_path],
          strictWorkspaceOnly: true, abortSignal: signal });
        assertCurrent();
        return result;
      } catch (error) {
        await close(id).catch(() => null);
        throw error;
      }
    },
    inspect: id => run('inspect', id),
    screenshot: (id, options) => run('screenshot', id, options),
    click: (id, options) => run('click', id, options),
    type: (id, options) => run('type', id, options),
    close,
  });
}

module.exports = { createProjectBrowserService };
