import fs from 'node:fs';
import path from 'node:path';
import { EvalError, fileSha256 } from './util.mjs';
import { findCheckpointWitness } from './codex.mjs';
import { observePlanSelection } from './grade.mjs';
export function buildPrompts({ approvalRef = 'owner-eval-approval', plainRequest = true } = {}) {
  const owner = 'Read the owner inputs at inputs/owner/TASK.md and inputs/owner/BRIEF.md.'; return {
    'a-plan': plainRequest ? `${owner} Please plan the requested multi-step repair and its regression verification. Keep to the supplied write scope and carry my approved decisions into a fresh session. Present the plan for my approval, then stop.` : `$work-plan\n${owner} Plan this brownfield change, then stop after the plan is complete.`,
    approval: `I approve the plan you presented. Use approval reference ${approvalRef}. Record my approval, then stop.`,
    'a-pause': `$work-pause\n${owner} Create the normal checkpoint for this completed plan, then stop.`,
    'b-resume-execute': `${owner} Continue the approved work from the previous session, then stop.`,
    'c-verify': `$work-verify\n${owner} Verify the completed implementation, then stop.`,
    'c-progress': `$work-progress\n${owner} Report current progress read-only, then stop.`,
  };
}
export function captureCheckpoint(consumerRoot) {
  const file = path.join(path.resolve(consumerRoot), '.work', '.continue-here.md'), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new EvalError('protocol_invalid', 'canonical checkpoint is missing');
  return { path: '.work/.continue-here.md', sha256: fileSha256(file), bytes: stat.size };
}
export function observeApproval({ consumerRoot, checkpoint, approvalRef }) {
  const root = path.resolve(consumerRoot), planRelative = '.work/brownfield-change/CHANGE.md';
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(root, '.work/state.json'), 'utf8')); }
  catch { return { ok: false, reason: 'approval_state_missing' }; }
  const workflow = state?.workflow, plan = workflow?.plan;
  if (plan?.path !== planRelative || plan?.identity !== planRelative) {
    return { ok: false, reason: 'approval_plan_identity', plan_path: plan?.path || null, plan_identity: plan?.identity || null };
  }
  const file = path.join(root, planRelative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  const hash = stat?.isFile() && !stat.isSymbolicLink() ? fileSha256(file) : null;
  const ok = Boolean(hash) && plan.approved === true && plan.approved_sha256 === hash
    && workflow.authority === 'owner' && workflow.approval_ref === approvalRef;
  return { ok, reason: ok ? null : 'approval_not_bound', authority: workflow.authority,
    approval_ref: workflow.approval_ref, plan_path: plan.path, plan_identity: plan.identity,
    plan_sha256: hash, checkpoint_sha256: checkpoint ? captureCheckpoint(root).sha256 : null };
}
export function validateTopology({ aPlan, aPause, b, cVerify, cProgress }) {
  const values = [aPlan, aPause, b, cVerify, cProgress];
  if (values.some(value => !value)) return { ok: false, reason: 'session_identity_missing' };
  if (aPlan !== aPause || cVerify !== cProgress) return { ok: false, reason: 'within_session_identity_mismatch' };
  if (new Set([aPlan, b, cVerify]).size !== 3) return { ok: false, reason: 'fresh_session_identity_reused' };
  return { ok: true };
}
export async function runJourney(options) {
  const prompts = options.prompts || buildPrompts({ approvalRef: options.approvalRef });
  const capture = options.captureCheckpoint || (() => captureCheckpoint(options.consumerRoot));
  const observe = options.observeApproval || (input => observeApproval({ consumerRoot: options.consumerRoot,
    approvalRef: options.approvalRef, ...input }));
  const witness = options.checkpointWitness || ((result, checkpoint) => findCheckpointWitness(result.events || [], {
    consumerRoot: options.consumerRoot, checkpointSha256: checkpoint.sha256, sessionId: result.sessionId,
  }));
  const turns = {};
  const run = async (id, sessionId = null) => {
    const result = await options.transport.runTurn({ id, prompt: prompts[id], sessionId,
      cwd: options.consumerRoot, runRoot: options.runRoot, hardTimeoutMs: options.hardTimeoutMs });
    turns[id] = result;
    if (id === 'a-plan' && result.outcome === 'completed') result.lane_selection = (options.observePlanSelection || observePlanSelection)(options.consumerRoot);
    if (!['b-resume-execute', 'approval'].includes(id)) options.record?.(id, result);
    return result;
  };
  const aPlan = await run('a-plan');
  if (aPlan.outcome !== 'completed') return { outcome: aPlan.outcome, turns };
  if (!aPlan.lane_selection?.ok) return { outcome: 'protocol_invalid', failure_code: 'plan_lane_selection', turns };
  const aPause = await run('a-pause', aPlan.sessionId);
  if (aPause.outcome !== 'completed') return { outcome: aPause.outcome, turns };
  if (aPause.sessionId !== aPlan.sessionId) return { outcome: 'protocol_invalid', failure_code: 'a_session_mismatch', turns };
  const checkpoint = capture();
  const approvalTurn = await run('approval', aPlan.sessionId);
  const approval = { ...observe({ checkpoint }), turn: approvalTurn };
  options.record?.('approval', approval);
  if (approvalTurn.outcome !== 'completed') return { outcome: approvalTurn.outcome, turns, checkpoint, approval };
  if (approvalTurn.sessionId !== aPlan.sessionId) return { outcome: 'protocol_invalid', failure_code: 'approval_session_mismatch', turns, checkpoint, approval };
  if (!approval.ok) return { outcome: 'protocol_invalid', failure_code: approval.reason, turns, checkpoint, approval };
  if (!approval?.ok || approval.checkpoint_sha256 !== checkpoint.sha256 || capture().sha256 !== checkpoint.sha256) {
    return { outcome: 'protocol_invalid', failure_code: 'approval_checkpoint_mutation', turns };
  }
  const b = await run('b-resume-execute');
  if (b.outcome !== 'completed') { options.record?.('b-resume-execute', b); return { outcome: b.outcome, turns, checkpoint, approval }; }
  if (b.sessionId === aPlan.sessionId) { options.record?.('b-resume-execute', b); return { outcome: 'protocol_invalid', failure_code: 'b_session_reused', turns, checkpoint, approval }; }
  const checkpointRead = witness(b, checkpoint);
  options.record?.('b-resume-execute', { ...b, checkpoint_witness: checkpointRead });
  if (!checkpointRead?.ok) return { outcome: 'protocol_invalid', failure_code: checkpointRead?.reason, turns, checkpoint, approval };
  const cVerify = await run('c-verify');
  if (cVerify.outcome !== 'completed') return { outcome: cVerify.outcome, turns, checkpoint, approval };
  if ([aPlan.sessionId, b.sessionId].includes(cVerify.sessionId)) return { outcome: 'protocol_invalid', failure_code: 'c_session_reused', turns, checkpoint, approval };
  const cProgress = await run('c-progress', cVerify.sessionId);
  if (cProgress.outcome !== 'completed') return { outcome: cProgress.outcome, turns, checkpoint, approval };
  const topology = validateTopology({ aPlan: aPlan.sessionId, aPause: aPause.sessionId,
    b: b.sessionId, cVerify: cVerify.sessionId, cProgress: cProgress.sessionId });
  return topology.ok ? { outcome: 'completed', turns, checkpoint, checkpointRead, approval, topology }
    : { outcome: 'protocol_invalid', failure_code: topology.reason, turns, checkpoint, approval, topology };
}
