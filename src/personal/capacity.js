// Keep only documented status data. Absent utilization is unknown, never zero.
export function capacityFromEvent(event) {
  if (event.type !== 'rate_limit_event' || !event.rate_limit_info) return null;
  const info = event.rate_limit_info;
  if (!['allowed','allowed_warning','rejected'].includes(info.status)) return null;
  const capacity = { status:info.status, observedAt:new Date().toISOString(), utilization:null, resetsAt:null };
  if (typeof info.utilization === 'number' && Number.isFinite(info.utilization) && info.utilization >= 0) capacity.utilization = info.utilization;
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) capacity.resetsAt = info.resetsAt;
  return capacity;
}
