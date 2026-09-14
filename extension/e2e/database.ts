import type { Page } from '@playwright/test';

export async function readTestDatabase(page: Page, profileId: string) {
  return page.evaluate(async id => {
    const repository = (window as any).KnowledgeGachaMaterialRepository.createMaterialRepository({ profileId: id });
    const db = await repository.get('state', 'current') || JSON.parse(localStorage.getItem('kg_extension_harness_v1:' + id) || '{}');
    for (const table of ['documents', 'materials', 'drafts', 'companionSessions']) for (const row of db[table] || []) {
      if (row.payloadId) Object.assign(row, await repository.get('payloads', row.payloadId));
    }
    await repository.close();
    return db;
  }, profileId);
}
