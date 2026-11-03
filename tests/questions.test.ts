import { afterEach, describe, expect, it } from 'vitest';
import { harnessFor, payload } from './helpers.js';
import * as fx from './fixtures.js';

describe('workvivo_get_question', () => {
  let h: Awaited<ReturnType<typeof harnessFor>> | undefined;
  afterEach(async () => {
    await h?.harness.close();
  });

  it('reads the question and its answers (GETs only — no log-view POST)', async () => {
    h = await harnessFor({ '/api/question-posts/4001': fx.questionPost, '/api/question-posts/4001/answers': fx.answers });
    const result = await h.harness.client.callTool({ name: 'workvivo_get_question', arguments: { question_id: 4001 } });
    expect(h.transport.apiCalls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/question-posts/4001',
      'GET /api/question-posts/4001/answers?page=1',
    ]);
    const p = payload(result) as { question: Record<string, unknown>; answers: Record<string, unknown>[]; next_page: number };
    expect(p.question).toMatchObject({
      id: 4001,
      title: 'Our mission',
      text: 'What is the club mission?',
      by: 'Alice Example',
      answered: true,
      accepted_answer_id: 4101,
      spaces: ['Speakers Club'],
      at: '2025-08-09T02:05:19Z',
    });
    expect(p.answers[0]).toMatchObject({ id: 4101, by: 'Bob Sample', text: 'To help people grow.', accepted: true, votes: 2 });
    expect(p.answers[1]).not.toHaveProperty('accepted');
    expect(p.next_page).toBe(2);
  });

  it('pages answers and returns both records unprojected on full', async () => {
    h = await harnessFor({ '/api/question-posts/4001': fx.questionPost, '/api/question-posts/4001/answers': { data: [], next_page_url: null } });
    const result = await h.harness.client.callTool({ name: 'workvivo_get_question', arguments: { question_id: 4001, page: 3, view: 'full' } });
    expect(h.transport.apiCalls.map((c) => c.path)).toContain('/api/question-posts/4001/answers?page=3');
    expect(payload(result)).toMatchObject({ question: { views_count: 40 }, answers: { data: [] } });
  });
});
