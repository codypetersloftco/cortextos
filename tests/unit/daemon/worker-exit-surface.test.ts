import { describe, it, expect, vi, beforeEach } from 'vitest';

const logEventMock = vi.fn();
const sendMessageMock = vi.fn();
vi.mock('../../../src/bus/event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));
vi.mock('../../../src/bus/message', () => ({ sendMessage: (...a: unknown[]) => sendMessageMock(...a) }));
// resolvePaths is pure path math but we stub it so the test never touches the fs.
vi.mock('../../../src/utils/paths', () => ({
  resolvePaths: (name: string) => ({ ctxRoot: '/ctx', inbox: `/ctx/inbox/${name}`, name }),
}));

import { surfaceWorkerExit } from '../../../src/daemon/worker-exit-surface';

describe('surfaceWorkerExit', () => {
  beforeEach(() => {
    logEventMock.mockReset();
    sendMessageMock.mockReset();
  });

  it('zero exit → SILENT (no event, no parent message)', () => {
    surfaceWorkerExit('default', 'org1', 'w1', 0, 'engineer');
    expect(logEventMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('non-zero exit → emits a durable worker_failed event (action/error) with the exit code', () => {
    surfaceWorkerExit('default', 'org1', 'prestage-worker', 3, 'penny');
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const args = logEventMock.mock.calls[0];
    // logEvent(paths, agentName, org, category, eventName, severity, metadata)
    expect(args[1]).toBe('prestage-worker');
    expect(args[2]).toBe('org1');
    expect(args[3]).toBe('action');
    expect(args[4]).toBe('worker_failed');
    expect(args[5]).toBe('error');
    expect(args[6]).toMatchObject({ worker: 'prestage-worker', exitCode: 3, parent: 'penny' });
  });

  it('non-zero exit WITH parent → also best-effort messages the parent (from=worker, to=parent, high)', () => {
    surfaceWorkerExit('default', 'org1', 'w2', 1, 'engineer');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const a = sendMessageMock.mock.calls[0];
    // sendMessage(paths, from, to, priority, text)
    expect(a[1]).toBe('w2');         // from = worker
    expect(a[2]).toBe('engineer');   // to = parent
    expect(a[3]).toBe('high');
    expect(String(a[4])).toContain('exited with code 1');
  });

  it('non-zero exit with NO parent → event only, no message', () => {
    surfaceWorkerExit('default', 'org1', 'w3', 2, undefined);
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('never throws even if the durable event emit fails — and still attempts the parent message', () => {
    logEventMock.mockImplementationOnce(() => { throw new Error('event write failed'); });
    expect(() => surfaceWorkerExit('default', 'org1', 'w4', 1, 'engineer')).not.toThrow();
    expect(sendMessageMock).toHaveBeenCalledTimes(1); // surfacing continues despite event failure
  });

  it('never throws even if the parent message fails', () => {
    sendMessageMock.mockImplementationOnce(() => { throw new Error('inbox write failed'); });
    expect(() => surfaceWorkerExit('default', 'org1', 'w5', 1, 'engineer')).not.toThrow();
    expect(logEventMock).toHaveBeenCalledTimes(1); // durable event still emitted
  });
});
