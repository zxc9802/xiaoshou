import { useState } from 'react';
import { MenuIcon, SparkIcon } from './Icons';
import { PersonalStyleSettings } from './PersonalStyleSettings';

export type RoutePath = '/' | '/materials' | '/customers' | '/reviews';

const links: Array<{ path: RoutePath; label: string }> = [
  { path: '/materials', label: '资料库' },
  { path: '/customers', label: '客户档案' },
  { path: '/reviews', label: '复盘中心' },
];

export function TopNavigation({ currentPath, onNavigate, followUpDueCount = 0 }: { currentPath: RoutePath; onNavigate: (path: RoutePath) => void; followUpDueCount?: number }) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const navigate = (path: RoutePath) => { onNavigate(path); setOpen(false); };
  return (
    <header className="top-nav">
      <div className="nav-inner">
        <button className="brand" onClick={() => navigate('/')} aria-label="返回AI销管工作台">
          <span className="brand-mark"><SparkIcon /></span><span>AI销管智能体</span>
        </button>
        <nav className={open ? 'nav-links is-open' : 'nav-links'} aria-label="主导航">
          {links.map((link) => <button key={link.path} className={currentPath === link.path ? 'nav-link active' : 'nav-link'} onClick={() => navigate(link.path)}>{link.label}{link.path === '/customers' && followUpDueCount > 0 && <span className="nav-reminder-badge" aria-label={`${followUpDueCount} 位客户待跟进`}>{followUpDueCount > 99 ? '99+' : followUpDueCount}</span>}</button>)}
        </nav>
        <div className="nav-actions">
          <button className="mobile-menu" aria-label="打开导航" onClick={() => setOpen(!open)}><MenuIcon /></button>
          <button className="avatar" aria-label="打开个人设置" onClick={() => setSettingsOpen(true)}>王</button>
        </div>
      </div>
      {settingsOpen && <PersonalStyleSettings onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
