/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { loadSessionTurns, type SessionTurn, type RespFile } from './chat';
import { getConvState, setConvState, useConversationTurn, type AsstMsg } from './conversation';

jest.mock('./chat', () => ({ loadSessionTurns: jest.fn(), streamResponse: jest.fn(), subscribeHarnessEvents: jest.fn(), cancelSession: jest.fn() }));
jest.mock('./workspace', () => ({ getCurrentWorkspaceRef: jest.fn() }));
jest.mock('./analytics', () => ({ track: jest.fn() }));
jest.mock('@/app/(app)/billing/lib', () => ({ billing: {} }));
jest.mock('./harness', () => ({ oobById: jest.fn() }));

const file: RespFile = { container_id: 'container', file_id: 'file', filename: 'report.txt' };
const turn = (files: RespFile[], metrics = true): SessionTurn => ({
  id: 'response', status: 'done', user: 'Create a report', assistant: 'Done', tools: [], files,
  ...(metrics ? { elapsed: 2, credits: 1 } : {}),
});
let sequence = 0;
function mount(files: RespFile[] = [], elapsed?: number) {
  const sid = `settled-files-${++sequence}`;
  setConvState(sid, { loaded: true, busy: false, msgs: [
    { role: 'user', text: 'Create a report' },
    { role: 'assistant', blocks: [{ kind: 'text', text: 'Done' }], files, status: 'done', elapsed },
  ] });
  function View() {
    useConversationTurn({ harnessId: 'test', sessionId: sid,
      target: { name: 'test', backend: 'test' }, onRan: jest.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(createElement(View)));
  const answer = () => getConvState(sid).msgs[1] as AsstMsg;
  return { sid, answer };
}
async function tick(ms: number) { await act(async () => { jest.advanceTimersByTime(ms); }); }

beforeEach(() => { jest.useFakeTimers(); jest.mocked(loadSessionTurns).mockReset(); });
afterEach(() => { act(() => { roots.splice(0).forEach((root) => root.unmount()); }); jest.useRealTimers(); });

it('recovers a persisted file missed by the terminal stream without reloading', async () => {
  jest.mocked(loadSessionTurns).mockResolvedValue({ turns: [turn([file])], lastResponseId: 'response' });
  const { answer } = mount();
  await tick(2500);
  expect(answer().files).toEqual([file]);
  expect(answer().elapsed).toBe(2);
});

it('keeps streamed files and deduplicates files also present in the settled record', async () => {
  const streamed = { ...file, file_id: 'streamed', filename: 'streamed.txt' };
  jest.mocked(loadSessionTurns).mockResolvedValue({ turns: [turn([file])], lastResponseId: 'response' });
  const { answer } = mount([streamed, file]);
  await tick(2500);
  expect(answer().files).toEqual([streamed, file]);
});

it('retries when the record has not settled yet', async () => {
  jest.mocked(loadSessionTurns)
    .mockResolvedValueOnce({ turns: [turn([], false)], lastResponseId: 'response' })
    .mockResolvedValueOnce({ turns: [turn([file])], lastResponseId: 'response' });
  const { answer } = mount();
  await tick(2500);
  expect(answer().files).toEqual([]);
  await tick(4000);
  expect(answer().files).toEqual([file]);
});

it('preserves streamed files when the settled record has no files', async () => {
  jest.mocked(loadSessionTurns).mockResolvedValue({ turns: [turn([])], lastResponseId: 'response' });
  const { answer } = mount([file]);
  await tick(2500);
  expect(answer().files).toEqual([file]);
});

it('keeps distinct files with the same name', async () => {
  const other = { ...file, file_id: 'other-file' };
  jest.mocked(loadSessionTurns).mockResolvedValue({ turns: [turn([other])], lastResponseId: 'response' });
  const { answer } = mount([file]);
  await tick(2500);
  expect(answer().files).toEqual([file, other]);
});

it('recovers files after a transient read failure', async () => {
  jest.mocked(loadSessionTurns)
    .mockRejectedValueOnce(new Error('Temporary read failure'))
    .mockResolvedValueOnce({ turns: [turn([file])], lastResponseId: 'response' });
  const { answer } = mount();
  await tick(2500);
  await tick(4000);
  expect(answer().files).toEqual([file]);
});
