const { normalizeString } = require('./backend/path-utils');

function toComparableTimestamp(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.valueOf();
}

function firstComparableTimestamp(values) {
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const timestamp = toComparableTimestamp(value);
    if (timestamp != null) {
      return timestamp;
    }
  }
  return null;
}

function firstRawTimeValue(values) {
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function compareIsoDesc(leftValue, rightValue) {
  const leftTimestamp = firstComparableTimestamp(leftValue);
  const rightTimestamp = firstComparableTimestamp(rightValue);
  if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  if (leftTimestamp != null && rightTimestamp == null) {
    return -1;
  }
  if (leftTimestamp == null && rightTimestamp != null) {
    return 1;
  }
  return firstRawTimeValue(rightValue).localeCompare(firstRawTimeValue(leftValue));
}

function compareFollowUpRecencyDesc(left, right) {
  return compareIsoDesc(
    [left?.updatedAt, left?.createdAt],
    [right?.updatedAt, right?.createdAt]
  );
}

function compareDeferredTimingAsc(left, right) {
  const leftTimestamp = firstComparableTimestamp(left?.deferredUntil);
  const rightTimestamp = firstComparableTimestamp(right?.deferredUntil);
  if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  if (leftTimestamp != null && rightTimestamp == null) {
    return -1;
  }
  if (leftTimestamp == null && rightTimestamp != null) {
    return 1;
  }
  return firstRawTimeValue(left?.deferredUntil).localeCompare(firstRawTimeValue(right?.deferredUntil));
}

function compareResolvedTimingDesc(left, right) {
  return compareIsoDesc(
    [left?.resolvedAt, left?.updatedAt, left?.createdAt],
    [right?.resolvedAt, right?.updatedAt, right?.createdAt]
  );
}

function compareSessionActivityDesc(left, right) {
  return compareIsoDesc(
    [left?.updated_at, left?.updatedAt, left?.created_at, left?.createdAt],
    [right?.updated_at, right?.updatedAt, right?.created_at, right?.createdAt]
  );
}

module.exports = {
  compareIsoDesc,
  compareFollowUpRecencyDesc,
  compareDeferredTimingAsc,
  compareResolvedTimingDesc,
  compareSessionActivityDesc,
};
