import { useEffect, useState } from 'react';
import { profileApi } from '../services/analysisApi';
import type { SalesStyleProfile } from '../types/analysis';

const initial: SalesStyleProfile = { customerAddressing: '', commonParticles: [], emojis: [], punctuation: '自然', messageSplitting: '单条', referenceMessages: [] };

export function PersonalStyleSettings({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState(initial);
  const [particles, setParticles] = useState('');
  const [emojis, setEmojis] = useState('');
  const [reference, setReference] = useState('');
  const [status, setStatus] = useState('正在读取个人表达习惯…');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void profileApi.getStyle().then((data) => { setProfile(data); setParticles(data.commonParticles.join('、')); setEmojis(data.emojis.join(' ')); setReference(data.referenceMessages.join('\n')); setStatus(''); }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : '加载失败')); }, []);
  const save = async () => {
    setSaving(true); setStatus('');
    const next: SalesStyleProfile = { ...profile, commonParticles: particles.split(/[、,，\s]+/).filter(Boolean).slice(0, 8), emojis: emojis.split(/\s+/).filter(Boolean).slice(0, 8), referenceMessages: reference.split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 5) };
    try { setProfile(await profileApi.saveStyle(next)); setStatus('已保存，将从下一次分析开始应用。'); } catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-style-title"><header><div><span>个人设置</span><h2 id="profile-style-title">我的销售表达风格</h2><p>只调整称呼、语气和拆条习惯，不会改变销售策略和事实。</p></div><button aria-label="关闭个人设置" onClick={onClose}>×</button></header><div className="profile-form"><label><span>常用客户称呼</span><input value={profile.customerAddressing} onChange={(event) => setProfile((current) => ({ ...current, customerAddressing: event.target.value }))} placeholder="例如：王总" maxLength={20} /></label><label><span>常用语气词</span><input value={particles} onChange={(event) => setParticles(event.target.value)} placeholder="例如：好的、明白、您看" /></label><label><span>常用 Emoji</span><input value={emojis} onChange={(event) => setEmojis(event.target.value)} placeholder="例如：😊 👍" /></label><div className="profile-choice"><span>标点风格</span>{(['简洁','自然','正式'] as const).map((item) => <button className={profile.punctuation === item ? 'active' : ''} key={item} onClick={() => setProfile((current) => ({ ...current, punctuation: item }))}>{item}</button>)}</div><div className="profile-choice"><span>消息习惯</span>{(['单条','分条'] as const).map((item) => <button className={profile.messageSplitting === item ? 'active' : ''} key={item} onClick={() => setProfile((current) => ({ ...current, messageSplitting: item }))}>{item}</button>)}</div><label><span>参考话术（每行一条，最多5条）</span><textarea value={reference} onChange={(event) => setReference(event.target.value)} placeholder="粘贴你平时最自然的客户回复" /></label></div>{status && <p className="profile-status" role="status">{status}</p>}<footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button></footer></section></div>;
}
