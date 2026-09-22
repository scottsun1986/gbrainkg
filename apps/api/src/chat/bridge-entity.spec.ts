import { ChatService } from './chat.service';

/**
 * The cascading multi-hop hop works by extracting a *bridge entity* from the
 * first-hop evidence and searching for it. Two defects made that hop useless for
 * exactly the questions it exists for:
 *
 *  - the loose prose regexes captured trailing sentence fragments
 *    ("George Stevens. The"), and the candidate was then fed to retrieval as a
 *    query, so the page that had just been discovered was never fetched;
 *  - discarding candidates that contained a sentence boundary threw away
 *    "Douglas Sirk. It" instead of trimming it to "Douglas Sirk".
 *
 * Both showed up as missing second-hop gold pages in the multi-hop benchmarks.
 */
describe('bridge entity extraction', () => {
  const service = Object.create(ChatService.prototype) as ChatService;
  const evidence = [
    'The More the Merrier is a 1943 American comedy film made by Columbia Pictures.',
    'The movie was directed by George Stevens.',
    'The film was written by Richard Flournoy.',
    'Sleep, My Love is a 1948 film directed by Douglas Sirk.',
    'It starred Claudette Colbert.',
  ].join(' ');

  it('extracts both directors from "directed by" phrasing, without prose tails', () => {
    const bridges = service.extractBridgeEntitiesFromEvidence(evidence, 'director');

    expect(bridges).toContain('George Stevens');
    expect(bridges).toContain('Douglas Sirk');
    for (const bridge of bridges) {
      expect(bridge).not.toMatch(/[.;:!?]\s/);
      expect(bridge).not.toMatch(/[.;:!?]$/);
    }
  });

  it('never returns the next sentence as part of an entity name', () => {
    const bridges = service.extractBridgeEntitiesFromEvidence(
      'The novel was written by Jane Austen. It was published in 1813.',
      'author',
    );
    expect(bridges.some((b) => /Austen$/i.test(b))).toBe(true);
    expect(bridges.every((b) => !/It$/.test(b))).toBe(true);
  });

  it('derives the relation word from the question in either inflection', () => {
    expect(service.extractRelationFromQuery('Who directed Sleep, My Love?')).toBeTruthy();
    expect(service.extractRelationFromQuery('Which film has the director who died later?')).toBe('director');
    expect(service.extractRelationFromQuery('普通的问题没有关系词')).toBeNull();
  });
});
