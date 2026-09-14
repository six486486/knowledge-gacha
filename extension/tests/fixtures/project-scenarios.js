const domain = require('../../src/frontend/domain/card-domain.js');

const DAY = 86400000;
function card(id, dueAt, now) {
  return domain.sanitizeCard({ id, contentVersion: 2, version: 1, title: '必要条件 ' + id,
    learningUnitId: 'unit_' + id, learningObjective: '应用规则前先核对必要条件', knowledgeType: 'concept',
    summary: '只有必要条件成立，才能应用本条规则。', boundaries: '不能把必要条件误当作充分条件。',
    example: { type: 'example', text: '设备有电是开机的必要条件，但有电不保证设备能正常开机。', origin: 'authored' },
    exerciseIds: ['exercise_' + id], citations: [], createdAt: now - DAY, updatedAt: now - DAY,
    dueAt, favorite: false, mastery: 0, reviewCount: 0 }, { now });
}
function exercise(card) {
  return { id: 'exercise_' + card.id, cardId: card.id, learningUnitId: card.learningUnitId, version: 1,
    type: 'choice', question: '题目只说明设备有电，可以直接断定设备一定能正常开机吗？',
    options: ['可以，有电就足够', '不可以，还要检查其他条件', '没有任何条件需要检查'], correctIndex: 1,
    answer: '不可以，还要检查其他条件', answerExplanation: '必要条件成立不保证结论成立。',
    rubric: ['区分必要条件与充分条件'], misconceptions: ['把必要条件当作充分条件', '', '忽略必要条件'] };
}
function fixtureData(kind, now) {
  let cards;
  if (kind === 'empty') cards = [];
  else if (kind === 'single-due') cards = [card('before', now - 1, now)];
  else if (kind === 'due-boundaries') cards = [card('before', now - 1, now), card('exact', now, now), card('after', now + 1, now)];
  else if (kind === 'large-library') cards = Array.from({ length: 1000 }, (_, i) => card('scale_' + String(i).padStart(4, '0'), now + (i < 600 ? -DAY : DAY), now));
  else throw new Error('Unknown authored test scenario: ' + kind);
  return { schemaVersion: 8, version: 1, learningState: { cards, pending: [], totalDraws: cards.length, reviewDay: { day: '', answered: 0, completed: false } },
    exercises: cards.map(exercise), reviewEvents: [], reviewSettings: { dailyGoal: 3 } };
}
module.exports = { DAY, card, exercise, fixtureData };
