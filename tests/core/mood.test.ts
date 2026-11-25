import { describe, it, expect } from 'vitest';
import { db } from '../../src/database';
import { MoodService } from '../../src/core/persona/mood-service';

describe('MoodService', () => {
  const moodService = new MoodService(db);

  it('initializes and retrieves default mood with composure', async () => {
    const mood = await moodService.getMood('owner');
    expect(mood.energy).toBeGreaterThanOrEqual(40);
    expect(mood.composure).toBeGreaterThanOrEqual(50);
    expect(mood.affection).toBeGreaterThanOrEqual(50);
    expect(mood.playfulness).toBeGreaterThanOrEqual(50);
  });

  it('applies mood delta correctly for owner', async () => {
    const before = await moodService.getMood('owner');
    const updated = await moodService.applyDelta(
      { affection: 3, playfulness: 4, composure: -2, energy: 1 },
      'owner'
    );

    expect(updated.affection).toBe(Math.min(100, before.affection + 3));
    expect(updated.playfulness).toBe(Math.min(100, before.playfulness + 4));
    expect(updated.composure).toBe(Math.max(0, before.composure - 2));
    expect(updated.energy).toBe(Math.min(100, before.energy + 1));
  });

  it('enforces role firewall: guest cannot alter affection', async () => {
    const before = await moodService.getMood('owner');
    const guestResult = await moodService.applyDelta(
      { affection: 5, playfulness: 2, composure: -1 },
      'guest'
    );

    expect(guestResult.affection).toBe(50);

    const ownerCheck = await moodService.getMood('owner');
    expect(ownerCheck.affection).toBe(before.affection);
    expect(ownerCheck.playfulness).toBe(Math.min(100, before.playfulness + 2));
  });

  it('formats mood description for system instruction with composure and role directives', async () => {
    const mood = await moodService.getMood('owner');
    const ownerDesc = moodService.formatMoodDescription(mood, 'owner', 'Asia/Jakarta');
    expect(ownerDesc).toContain('[CURRENT EMOTIONAL STATE & MOOD MODIFIERS]');
    expect(ownerDesc).toContain('Energy:');
    expect(ownerDesc).toContain('Composure:');

    const guestMood = await moodService.getMood('guest');
    const guestDesc = moodService.formatMoodDescription(guestMood, 'guest', 'Asia/Jakarta');
    expect(guestDesc).toContain('Guest Boundary:');
  });
});
