import { useEffect, useMemo, useState } from 'react';
import type { CustomerDealStatus, CustomerProfile } from '../types/analysis';
import { customerApi } from '../services/analysisApi';
import { ArrowIcon, CheckIcon, SparkIcon } from './Icons';

const temperatureLabels = { high: '高意向', mid: '中等意向', low: '低意向' } as const;

export function CustomerProfilesPage({ onBack, onOpenAnalysis, onReminderChange }: { onBack: () => void; onOpenAnalysis: (analysisId: string) => void; onReminderChange: () => void | Promise<void> }) {
  const [profiles, setProfiles] = useState<CustomerProfile[]>([]);
  const [dealStatus, setDealStatus] = useState<CustomerDealStatus>('unwon');
  const [stage, setStage] = useState('全部未成交');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    customerApi.list().then(setProfiles).catch((caught) => setError(caught instanceof Error ? caught.message : '客户档案加载失败')).finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => ({
    total: profiles.length,
    unwon: profiles.filter((profile) => profile.dealStatus === 'unwon').length,
    won: profiles.filter((profile) => profile.dealStatus === 'won').length,
    due: profiles.filter((profile) => profile.dealStatus === 'unwon' && profile.followUpDue).length,
  }), [profiles]);

  const stageCounts = useMemo(() => {
    const values = new Map<string, number>();
    profiles.filter((profile) => profile.dealStatus === 'unwon').forEach((profile) => values.set(profile.stage, (values.get(profile.stage) ?? 0) + 1));
    return [...values.entries()].sort((left, right) => right[1] - left[1]);
  }, [profiles]);

  const visible = useMemo(() => profiles.filter((profile) => {
    if (profile.dealStatus !== dealStatus) return false;
    if (dealStatus === 'unwon' && stage === '待跟进' && !profile.followUpDue) return false;
    if (dealStatus === 'unwon' && stage !== '全部未成交' && stage !== '待跟进' && profile.stage !== stage) return false;
    const keyword = query.trim().toLowerCase();
    return !keyword || [profile.displayName, profile.remarkName, profile.nickname, profile.company, profile.location, profile.industry, profile.summary, profile.latestMessage].filter(Boolean).join(' ').toLowerCase().includes(keyword);
  }).sort((left, right) => {
    if (left.followUpDue !== right.followUpDue) return left.followUpDue ? -1 : 1;
    return Date.parse(left.nextFollowUpAt) - Date.parse(right.nextFollowUpAt);
  }), [dealStatus, profiles, query, stage]);

  const changeStatus = async (profile: CustomerProfile) => {
    const nextStatus: CustomerDealStatus = profile.dealStatus === 'won' ? 'unwon' : 'won';
    try {
      setUpdatingId(profile.id); setError('');
      const updated = await customerApi.setStatus(profile.id, nextStatus);
      setProfiles((items) => items.map((item) => item.id === updated.id ? updated : item));
      void onReminderChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '档案状态更新失败'); }
    finally { setUpdatingId(''); }
  };

  const updateFollowUp = async (profile: CustomerProfile, action: 'completed' | 'snooze') => {
    try {
      setUpdatingId(profile.id); setError('');
      const updated = await customerApi.updateFollowUp(profile.id, action);
      setProfiles((items) => items.map((item) => item.id === updated.id ? updated : item));
      void onReminderChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '跟进提醒更新失败'); }
    finally { setUpdatingId(''); }
  };

  const saveRemark = async (profile: CustomerProfile, remark: string) => {
    try {
      setUpdatingId(profile.id); setError('');
      const updated = await customerApi.setRemark(profile.id, remark);
      setProfiles((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) { setError(caught instanceof Error ? caught.message : '客户备注保存失败'); throw caught; }
    finally { setUpdatingId(''); }
  };

  const selectDealStatus = (status: CustomerDealStatus) => {
    setDealStatus(status);
    setStage('全部未成交');
  };

  return <main className="customer-page">
    <header className="customer-header">
      <div><span><SparkIcon /> 自动客户建档</span><h1>客户档案</h1><p>收到客户对话后自动同步截图中可见的头像、昵称与备注，并整理需求和跟进阶段；无法确认的信息保持为空。</p></div>
      <button className="secondary-button" onClick={onBack}>返回工作台</button>
    </header>

    {error && <div className="workspace-error" role="alert">{error}</div>}
    <section className="customer-metrics" aria-label="客户档案概览">
      <article><span>全部档案</span><strong>{counts.total}</strong><small>根据对话自动建立</small></article>
      <article><span>未成交</span><strong>{counts.unwon}</strong><small>继续按照阶段跟进</small></article>
      <article className="won"><span>已成交</span><strong>{counts.won}</strong><small>沉淀成交客户关系</small></article>
      <div><CheckIcon /><span>同一客户会优先匹配并更新原档案，不重复建档；头像、昵称和备注以截图可见信息为准。</span></div>
    </section>

    <section className="customer-directory">
      <header>
        <div className="customer-deal-tabs" role="tablist" aria-label="成交状态">
          <button role="tab" aria-selected={dealStatus === 'unwon'} className={dealStatus === 'unwon' ? 'active' : ''} onClick={() => selectDealStatus('unwon')}>未成交 <em>{counts.unwon}</em></button>
          <button role="tab" aria-selected={dealStatus === 'won'} className={dealStatus === 'won' ? 'active' : ''} onClick={() => selectDealStatus('won')}>已成交 <em>{counts.won}</em></button>
        </div>
        <label className="customer-search"><span className="visually-hidden">搜索客户档案</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户、公司、行业或需求…" /></label>
      </header>
      {dealStatus === 'unwon' && <div className="customer-stage-filters" aria-label="未成交客户阶段">
        <button className={stage === '全部未成交' ? 'active' : ''} onClick={() => setStage('全部未成交')}>全部未成交 <span>{counts.unwon}</span></button>
        <button className={stage === '待跟进' ? 'active follow-up' : 'follow-up'} onClick={() => setStage('待跟进')}>待跟进 <span>{counts.due}</span></button>
        {stageCounts.map(([name, count]) => <button key={name} className={stage === name ? 'active' : ''} onClick={() => setStage(name)}>{name} <span>{count}</span></button>)}
      </div>}

      {loading ? <div className="customer-empty">正在整理客户档案…</div> : visible.length ? <div className="customer-profile-list">{visible.map((profile) => <CustomerProfileCard key={profile.id} profile={profile} updating={updatingId === profile.id} onSaveRemark={(remark) => saveRemark(profile, remark)} onChangeStatus={() => void changeStatus(profile)} onFollowUp={(action) => void updateFollowUp(profile, action)} onOpen={() => onOpenAnalysis(profile.latestAnalysisId)} />)}</div> : <div className="customer-empty"><span><SparkIcon /></span><strong>{query ? '没有找到匹配档案' : stage === '待跟进' ? '当前没有待跟进客户' : dealStatus === 'won' ? '暂时没有已成交客户' : '当前分类暂无客户'}</strong><p>{query ? '可以换一个关键词继续搜索。' : stage === '待跟进' ? '客户超过72小时没有新进展时会自动出现在这里。' : '完成新的客户对话分析后，档案会自动出现在这里。'}</p></div>}
    </section>
  </main>;
}

function CustomerProfileCard({ profile, updating, onSaveRemark, onChangeStatus, onFollowUp, onOpen }: { profile: CustomerProfile; updating: boolean; onSaveRemark: (remark: string) => Promise<void>; onChangeStatus: () => void; onFollowUp: (action: 'completed' | 'snooze') => void; onOpen: () => void }) {
  const [editingRemark, setEditingRemark] = useState(false);
  const [remark, setRemark] = useState(profile.manualRemark ?? profile.displayName);
  const [savingRemark, setSavingRemark] = useState(false);
  const nickname = profile.nickname && profile.nickname !== profile.displayName ? `昵称：${profile.nickname}` : undefined;
  const detail = [nickname, profile.company, profile.location, profile.industry, profile.teamSize ? `${profile.teamSize}人团队` : undefined].filter(Boolean);
  const submitRemark = async () => {
    const value = remark.trim();
    if (!value || value === profile.displayName) { setEditingRemark(false); setRemark(profile.displayName); return; }
    try { setSavingRemark(true); await onSaveRemark(value); setEditingRemark(false); }
    finally { setSavingRemark(false); }
  };
  return <article className="customer-profile-card">
    <header>
      <span className={`customer-avatar ${profile.avatarUrl ? 'has-image' : ''}`}>{profile.displayName.slice(0, 1)}{profile.avatarUrl && <img src={profile.avatarUrl} alt={`${profile.displayName}的头像`} onError={(event) => { event.currentTarget.style.display = 'none'; }} />}</span>
      <div>{editingRemark ? <div className="customer-remark-editor"><input autoFocus maxLength={40} aria-label="客户备注" value={remark} onChange={(event) => setRemark(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submitRemark(); if (event.key === 'Escape') { setEditingRemark(false); setRemark(profile.displayName); } }} /><button disabled={savingRemark || !remark.trim()} onClick={() => void submitRemark()}>{savingRemark ? '保存中' : '保存'}</button><button disabled={savingRemark} onClick={() => { setEditingRemark(false); setRemark(profile.displayName); }}>取消</button></div> : <div className="customer-name-row"><h2>{profile.displayName}</h2><button className="customer-edit-remark" onClick={() => { setRemark(profile.manualRemark ?? profile.displayName); setEditingRemark(true); }}>修改备注</button></div>}<p>{detail.length ? detail.join(' · ') : '客户基础信息待补充'}</p></div>
      <span className={`customer-deal-badge ${profile.dealStatus}`}>{profile.dealStatus === 'won' ? '已成交' : '未成交'}</span>
    </header>
    {profile.dealStatus === 'unwon' && (profile.followUpDue ? <div className="customer-follow-up-alert">
      <div><strong>{profile.followUpOverdueDays > 0 ? `已超期 ${profile.followUpOverdueDays} 天` : `已 ${Math.max(3, Math.floor((Date.now() - Date.parse(profile.lastProgressAt)) / 86400000))} 天未跟进`}</strong><span>最近进展：{formatFollowUpTime(profile.lastProgressAt)} · 建议现在联系客户</span></div>
      <div><button disabled={updating} onClick={() => onFollowUp('snooze')}>明天提醒</button><button className="complete" disabled={updating} onClick={() => onFollowUp('completed')}>{updating ? '处理中…' : '已跟进'}</button></div>
    </div> : <div className="customer-follow-up-scheduled">下次提醒：{formatFollowUpTime(profile.nextFollowUpAt)}</div>)}
    <div className="customer-profile-body">
      <section><span>当前阶段</span><div className="customer-stage-line"><strong>{profile.dealStatus === 'won' ? '已成交' : profile.stage}</strong>{profile.stageConfidence !== undefined && <em>置信度 {profile.stageConfidence}%</em>}{profile.intentTemperature && <i>{temperatureLabels[profile.intentTemperature]}</i>}</div></section>
      <section><span>客户判断</span><p>{profile.summary}</p></section>
      <section><span>明确需求</span>{profile.explicitNeeds.length ? <div className="customer-needs">{profile.explicitNeeds.map((need) => <em key={need}>{need}</em>)}</div> : <p>等待下一轮对话补充明确需求。</p>}</section>
      <section><span>最近消息</span><p>“{profile.latestMessage}”</p></section>
    </div>
    <footer><span>{profile.conversationCount} 轮分析 · 更新于 {new Date(profile.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><div><button className="secondary-button" disabled={updating} onClick={onChangeStatus}>{updating ? '更新中…' : profile.dealStatus === 'won' ? '转为未成交' : '标记已成交'}</button><button className="customer-open-button" onClick={onOpen}>查看最近分析 <ArrowIcon /></button></div></footer>
  </article>;
}

function formatFollowUpTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
