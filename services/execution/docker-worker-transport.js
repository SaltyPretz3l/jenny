'use strict';
const { randomUUID } = require('node:crypto');
const { encodeEnvelope, decodeEnvelope, validateResponse } = require('./worker-protocol');
const { sandboxError } = require('./sandbox-errors');
class DockerWorkerTransport {
  constructor({ launcher, containerId, imageId, snapshotDirectory }) {
    Object.assign(this, { launcher, containerId, imageId, snapshotDirectory });
    this.key = null;
    this.submittedStartedAt = null;
  }
  async request(operation, fields = {}) {
    const inspected = await this.launcher.verify(this.containerId, this);
    if (!inspected.State.Running || inspected.State.Restarting) throw sandboxError('worker_not_running');
    if (!this.key) {
      const key = await this.launcher.relay(this.containerId, 'bootstrap');
      if (key.length !== 32) throw sandboxError('worker_key_invalid');
      this.key = key;
    }
    const request = { ...fields, schema_version: 1, request_id: randomUUID(), operation };
    const wire = Buffer.from(encodeEnvelope(request, this.key));
    if (wire.length > 128 * 1024) throw sandboxError('worker_request_limit');
    if (operation === 'submit') {
      this.submittedStartedAt = inspected.State.StartedAt;
      this.submittedJob = fields.job_id;
      this.submittedIncarnation = fields.incarnation;
    }
    const data = await this.launcher.relay(this.containerId, 'request', wire, operation === 'submit' ? this.admissionCheck : null);
    if (!data.length || data.length > 3 * 1024 * 1024 || data[data.length - 1] !== 10
      || data.subarray(0, -1).includes(10)) throw sandboxError('worker_response_invalid');
    const result = validateResponse(decodeEnvelope(data.toString('utf8').trimEnd(), this.key, { response: true }), request);
    if (operation === 'status' && this.submittedStartedAt
      && result.previous_result?.job_id === this.submittedJob
      && result.previous_result?.incarnation === this.submittedIncarnation) {
      const after = await this.launcher.verify(this.containerId, this);
      if (after.State.StartedAt === this.submittedStartedAt || !after.State.Running || after.State.Restarting) {
        throw sandboxError('sandbox_cleanup_unconfirmed');
      }
    }
    return result;
  }
  dispose() { this.key?.fill(0); this.key = null; }
}
module.exports = { DockerWorkerTransport };