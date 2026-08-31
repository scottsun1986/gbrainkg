export const PERMISSIONS = {
  CHAT_USE: "chat.use",
  KB_READ: "kb.read",
  ORG_READ: "org.read",
  ORG_USER_READ: "org.user.read",
  ORG_USER_MANAGE: "org.user.manage",
  ORG_NODE_CREATE: "org.node.create",
  ROLE_READ: "role.read",
  ROLE_MANAGE: "role.manage",
  INDUSTRY_READ: "kb.industry.read",
  INDUSTRY_CREATE: "kb.industry.create",
  INDUSTRY_MANAGE: "kb.industry.manage",
  INDUSTRY_GRANT: "kb.industry.grant",
  SYSTEM_SETTINGS_READ: "system.settings.read",
  SYSTEM_SETTINGS_MANAGE: "system.settings.manage",
  AUDIT_READ: "audit.read",
} as const;

export const BASE_USER_PERMISSIONS = [
  PERMISSIONS.CHAT_USE,
  PERMISSIONS.KB_READ,
];

export const DEFAULT_ROLES = [
  {
    name: "普通用户",
    description: "使用对话、知识库和知识图谱",
    builtin: false,
    permissions: BASE_USER_PERMISSIONS,
  },
  {
    name: "组织管理员",
    description: "管理本人组织及全部下级组织的人员和子组织",
    builtin: false,
    permissions: [
      ...BASE_USER_PERMISSIONS,
      PERMISSIONS.ORG_READ,
      PERMISSIONS.ORG_USER_READ,
      PERMISSIONS.ORG_USER_MANAGE,
      PERMISSIONS.ORG_NODE_CREATE,
    ],
  },
  {
    name: "行业库管理员",
    description: "行业库管理功能角色，实际范围由具体行业库管理员关系决定",
    builtin: false,
    // 角色只负责进入行业库管理模块；具体能维护/授权哪些库，必须再由
    // KnowledgeBase.ownerUserId / kbAdmin 关系决定，不能由角色扩大资源范围。
    permissions: [
      ...BASE_USER_PERMISSIONS,
      PERMISSIONS.INDUSTRY_READ,
      PERMISSIONS.INDUSTRY_GRANT,
    ],
  },
  {
    name: "行业库创建者",
    description: "创建行业知识库，并保留设置管理员和删除本人所建知识库的权限",
    builtin: false,
    permissions: [
      ...BASE_USER_PERMISSIONS,
      PERMISSIONS.INDUSTRY_READ,
      PERMISSIONS.INDUSTRY_CREATE,
    ],
  },
  {
    name: "系统管理员",
    description: "系统级用户、组织、角色、知识库、模型和审计管理",
    builtin: true,
    permissions: ["*"],
  },
  {
    name: "超级管理员",
    description: "系统最高权限角色",
    builtin: true,
    permissions: ["*"],
  },
];
