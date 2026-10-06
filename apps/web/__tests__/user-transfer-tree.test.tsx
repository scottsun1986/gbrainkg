import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UserTransferTree, groupUsersByOrg, buildOrgTree, matchesUserQuery, type TransferUser, type TransferOrg } from '../src/components/common/UserTransferTree';

const users: TransferUser[] = [
  { id: 'u1', name: '张三', org: '研发中心', kw: 'zhangsan' },
  { id: 'u2', name: '李四', org: '研发中心', kw: 'lisi' },
  { id: 'u3', name: '王五', org: '财务部', kw: 'wangwu' },
  { id: 'u4', name: '赵六', org: '', kw: 'zhaoliu' },
];

const html = (selectedIds: string[], list = users) =>
  renderToStaticMarkup(<UserTransferTree users={list} selectedIds={selectedIds} onChange={() => {}} />);

describe('UserTransferTree pure helpers', () => {
  it('groups users by org and folds blank orgs into 未分配组织', () => {
    const groups = groupUsersByOrg(users);
    assert.deepEqual(groups.map(([org]) => org).sort(), ['未分配组织', '研发中心', '财务部'].sort());
    const rd = groups.find(([org]) => org === '研发中心');
    assert.equal(rd?.[1].length, 2);
    assert.equal(groups.find(([org]) => org === '未分配组织')?.[1][0].id, 'u4');
  });

  it('matches by name, org, account keyword and is blank-query permissive', () => {
    assert.equal(matchesUserQuery(users[0], ''), true);
    assert.equal(matchesUserQuery(users[0], '张'), true);
    assert.equal(matchesUserQuery(users[0], '研发'), true);
    assert.equal(matchesUserQuery(users[0], 'lisi'), false);
    assert.equal(matchesUserQuery(users[1], 'LISI'), true);
    assert.equal(matchesUserQuery(users[0], '财务'), false);
  });
});

describe('UserTransferTree rendering', () => {
  it('renders both panes with selected users excluded from the available pane', () => {
    const out = html(['u2']);
    assert.ok(out.includes('可选人员'));
    assert.ok(out.includes('已选人员'));
    // 张三 only appears in the available pane; 李四 only in the selected pane.
    assert.equal((out.match(/张三/g) || []).length, 1);
    assert.equal((out.match(/李四/g) || []).length, 1);
    assert.ok(out.includes('共选择 <b>1</b> 人'));
  });

  it('shows selected count and group headers with member counts', () => {
    const out = html(['u1', 'u3']);
    assert.ok(out.includes('共选择 <b>2</b> 人'));
    assert.ok(out.includes('研发中心'));
    assert.ok(out.includes('财务部'));
  });

  it('disables transfer buttons when the corresponding direction is empty', () => {
    const out = html([]);
    // leftChecked/rightChecked empty → → and ← disabled; selected empty → ⇇ disabled;
    // only ⇉ (add all) stays enabled because available users exist.
    assert.equal((out.match(/disabled/g) || []).length, 3);
  });
});

describe('UserTransferTree organization hierarchy', () => {
  const orgs: TransferOrg[] = [
    { id: 'o1', name: '演示公司', parentId: null },
    { id: 'o2', name: '市场部', parentId: 'o1' },
    { id: 'o3', name: '软件研发中心', parentId: 'o2' },
    { id: 'o4', name: '研发一组', parentId: 'o3' },
  ];
  const husers: TransferUser[] = [
    { id: 'h1', name: '张三', orgIds: ['o4'] },
    { id: 'h2', name: '李四', orgIds: ['o2'] },
    { id: 'h3', name: '王五' },
  ];

  it('builds parent/child index and roots from flat org list', () => {
    const { roots, childrenByParent } = buildOrgTree(orgs);
    assert.deepEqual(roots.map((o) => o.id), ['o1']);
    assert.equal(childrenByParent.get('o3')?.[0].id, 'o4');
  });

  it('renders the real org hierarchy and nests users under their org node', () => {
    const out = renderToStaticMarkup(<UserTransferTree users={husers} orgs={orgs} selectedIds={[]} onChange={() => {}} />);
    for (const name of ['演示公司', '市场部', '软件研发中心', '研发一组']) assert.ok(out.includes(name), name);
    assert.ok(out.includes('未分配组织'));
    assert.ok(out.includes('张三'));
    assert.ok(out.includes('王五'));
    assert.ok(out.includes('ut-org-head'));
  });
});
