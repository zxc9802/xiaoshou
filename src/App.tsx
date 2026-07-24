import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnalysisWorkspace } from './components/AnalysisWorkspace';
import { CustomerProfilesPage } from './components/CustomerProfilesPage';
import { KnowledgeBasePage } from './components/KnowledgeBasePage';
import { ReviewCenterPage } from './components/ReviewCenterPage';
import { TopNavigation, type RoutePath } from './components/TopNavigation';
import { analysisApi, analysisSteps, customerApi, progressIndex, runtimeConfigApi } from './services/analysisApi';
import type { AnalysisHistoryItem, AnalysisJob, AnalysisRequest, ParsedConversation } from './types/analysis';

function toRoute(pathname: string): RoutePath {
  if (pathname === '/rules') return '/materials';
  return ['/', '/materials', '/customers', '/reviews'].includes(pathname) ? pathname as RoutePath : '/';
}

const activeStatuses = new Set(['uploaded', 'parsing', 'classifying', 'retrieving', 'generating']);

export function App() {
  const [path, setPath] = useState<RoutePath>(() => toRoute(window.location.pathname));
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [history, setHistory] = useState<AnalysisHistoryItem[]>([]);
  const [followUpDueCount, setFollowUpDueCount] = useState(0);
  const [analysisKnowledgeEnabled, setAnalysisKnowledgeEnabled] = useState(false);
  const [error, setError] = useState('');

  const loadHistory = useCallback(async () => { try { setHistory(await analysisApi.list()); } catch { /* API may still be starting. */ } }, []);
  const loadReminderSummary = useCallback(async () => { try { setFollowUpDueCount((await customerApi.reminderSummary()).dueCount); } catch { /* API may still be starting. */ } }, []);
  useEffect(() => {
    const onPopState = () => setPath(toRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState); void loadHistory(); void loadReminderSummary();
    return () => window.removeEventListener('popstate', onPopState);
  }, [loadHistory, loadReminderSummary]);
  useEffect(() => {
    const timer = window.setInterval(() => void loadReminderSummary(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadReminderSummary]);
  useEffect(() => {
    void runtimeConfigApi.get()
      .then((runtime) => setAnalysisKnowledgeEnabled(runtime.analysisKnowledgeEnabled))
      .catch(() => setAnalysisKnowledgeEnabled(false));
  }, []);
  useEffect(() => {
    if (!job || !activeStatuses.has(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await analysisApi.get(job.id); setJob(next);
        if (!activeStatuses.has(next.status)) void loadHistory();
      } catch (caught) { setError(caught instanceof Error ? caught.message : '获取分析进度失败'); }
    }, 700);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, loadHistory]);

  const navigate = (next: RoutePath) => { window.history.pushState({}, '', next); setPath(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const analyze = async (request: AnalysisRequest) => {
    try {
      setError('');
      const next = job?.result ? await analysisApi.continue(job.id, request) : await analysisApi.create(request);
      setJob(next); void loadHistory(); void loadReminderSummary();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '提交分析失败'); }
  };
  const selectHistory = async (id: string) => {
    try {
      setError('');
      setJob(await analysisApi.get(id));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '加载历史记录失败';
      if (message.includes('不存在') || message.toLowerCase().includes('not found')) {
        setHistory((items) => items.filter((item) => item.id !== id));
        if (job?.id === id) setJob(null);
      }
      setError(message);
      void loadHistory();
    }
  };
  const deleteHistory = async (id: string) => {
    if (!window.confirm('确定删除这条历史对话吗？相关分析、截图和复盘记录也会一并删除。')) return;
    try {
      setError('');
      await analysisApi.remove(id);
      setHistory((items) => items.filter((item) => item.id !== id));
      if (job?.id === id) setJob(null);
      void loadHistory();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '删除历史记录失败';
      if (message.includes('不存在') || message.toLowerCase().includes('not found')) {
        setHistory((items) => items.filter((item) => item.id !== id));
        if (job?.id === id) setJob(null);
        void loadHistory();
        return;
      }
      setError(message);
    }
  };
  const openCustomerAnalysis = async (id: string) => { navigate('/'); await selectHistory(id); };
  const confirmTranscript = async (transcript: ParsedConversation) => { if (!job) return; try { setJob(await analysisApi.confirmTranscript(job.id, transcript)); } catch (caught) { setError(caught instanceof Error ? caught.message : '确认失败'); } };
  const clarify = async (answers: Array<{ id: string; answer: string }>) => { if (!job) return; try { setJob(await analysisApi.clarify(job.id, answers)); } catch (caught) { setError(caught instanceof Error ? caught.message : '提交补充信息失败'); } };
  const cancel = async () => { if (!job) return; try { setError(''); setJob(await analysisApi.cancel(job.id)); void loadHistory(); } catch (caught) { setError(caught instanceof Error ? caught.message : '取消分析失败'); } };
  const retry = async () => { if (!job) return; try { setError(''); setJob(await analysisApi.retry(job.id)); } catch (caught) { setError(caught instanceof Error ? caught.message : '重新分析失败'); } };
  const reset = () => { setJob(null); setError(''); };
  const busy = Boolean(job && activeStatuses.has(job.status));
  const request = job?.request ? { ...job.request } : null;
  const result = job?.result ?? null;
  const currentProgress = useMemo(() => progressIndex(job, analysisKnowledgeEnabled), [job, analysisKnowledgeEnabled]);
  const currentAnalysisSteps = useMemo(() => analysisSteps(analysisKnowledgeEnabled), [analysisKnowledgeEnabled]);

  let page;
  if (path === '/') page = <AnalysisWorkspace request={request} result={result} job={job} history={history} busy={busy} progress={currentProgress} progressSteps={currentAnalysisSteps} analysisKnowledgeEnabled={analysisKnowledgeEnabled} error={error} onAnalyze={analyze} onReset={reset} onSelectHistory={selectHistory} onDeleteHistory={deleteHistory} onConfirmTranscript={confirmTranscript} onClarify={clarify} onCancel={cancel} onRetry={retry} />;
  else if (path === '/materials') page = <KnowledgeBasePage onBack={() => navigate('/')} />;
  else if (path === '/customers') page = <CustomerProfilesPage onBack={() => navigate('/')} onOpenAnalysis={(id) => void openCustomerAnalysis(id)} onReminderChange={loadReminderSummary} />;
  else page = <ReviewCenterPage onBack={() => navigate('/')} analysisKnowledgeEnabled={analysisKnowledgeEnabled} />;
  return <><TopNavigation currentPath={path} onNavigate={navigate} followUpDueCount={followUpDueCount} />{page}</>;
}
