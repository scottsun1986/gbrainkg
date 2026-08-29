export enum KnowledgeBaseType {
  PERSONAL = 'personal',
  ORG = 'org',
  INDUSTRY = 'industry',
}

export enum CompileTrigger {
  KNOWLEDGE_PUBLISH = 'knowledge_publish',
  PERM_GRANT = 'perm_grant',
  PERM_REVOKE = 'perm_revoke',
  ORG_CHANGE = 'org_change',
  DREAM = 'dream',
  LAZY = 'lazy',
}

export interface DirtyJobPayload {
  userId: string;
  topicId: string;
  source: CompileTrigger;
  priority: number;
  kbIds: string[];
  docIds: string[];
  createdAt: string;
}
