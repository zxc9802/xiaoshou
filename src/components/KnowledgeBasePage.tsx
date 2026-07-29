import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { KnowledgeCandidate, KnowledgeEntry, KnowledgeImportContext, KnowledgeImportJob, KnowledgeMediaAsset, ProductPackage, ProductProfileDetail, ProductProfileView } from '../types/analysis';
import { knowledgeApi, productApi } from '../services/analysisApi';
import { CheckIcon, PlusIcon, ShieldIcon, UploadIcon } from './Icons';
import { buildReviewImportOptions } from './knowledgeReviewQueue';

const defaultBusinessCategories = ['产品资料', '客户案例', '竞品口径', '售后承诺', '禁用红线', '销售技巧'] as const;
const blockedPattern = /\.(exe|dll|msi|bat|cmd|com|scr|ps1|sh|vbs|js|jar)$/i;

function entryBusinessCategory(entry: KnowledgeEntry) {
  const rawValue = entry.structuredData?.businessCategory;
  if (!rawValue) {
    const text = `${entry.category}\n${entry.title}\n${entry.content}`;
    if (entry.layer === 'L0' || /红线|禁用|不得|不能承诺|禁止|合规/.test(text)) return '禁用红线';
    if (entry.layer === 'L1' || entry.layer === 'L2' || entry.layer === 'L4') return '销售技巧';
    if (/客户案例|客户故事|成功实践|标杆客户/.test(text)) return '客户案例';
    if (/竞品|友商|对比口径/.test(text)) return '竞品口径';
    if (/售后|服务保障|退款|退货|SLA/.test(text)) return '售后承诺';
    return '产品资料';
  }
  const value = String(rawValue);
  if (value === '价格政策' || value === '实施交付' || value === '其他资料') return '产品资料';
  if (value === '销售策略') return '销售技巧';
  return defaultBusinessCategories.includes(value as typeof defaultBusinessCategories[number]) ? value : '产品资料';
}

function entryMediaAssets(entry: KnowledgeEntry) {
  return Array.isArray(entry.structuredData?.mediaAssets) ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[] : [];
}

function pendingCandidates(job: KnowledgeImportJob) {
  return job.candidates.filter((candidate) => candidate.reviewStatus !== 'discarded');
}

function isLockedEntry(entry: KnowledgeEntry) {
  return entry.origin === 'system' || entry.locked === true;
}

function originLabel(entry: KnowledgeEntry) {
  if (isLockedEntry(entry)) return '系统通用';
  return entry.origin === 'import' ? 'AI导入' : '手动新增';
}

export function KnowledgeBasePage({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [imports, setImports] = useState<KnowledgeImportJob[]>([]);
  const [products, setProducts] = useState<ProductProfileView[]>([]);
  const [businessFilter, setBusinessFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [openProductForm, setOpenProductForm] = useState(false);
  const [productDetail, setProductDetail] = useState<ProductProfileDetail | null>(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [detailEntry, setDetailEntry] = useState<KnowledgeEntry | null>(null);
  const [reviewJob, setReviewJob] = useState<KnowledgeImportJob | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewScope, setViewScope] = useState<'active' | 'trash'>('active');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);

  const load = async (scope = viewScope) => {
    try {
      setLoading(true);
      const [knowledgeEntries, importJobs, productProfiles] = await Promise.all([knowledgeApi.list(scope), knowledgeApi.listImports(), productApi.list()]);
      setEntries(knowledgeEntries);
      setImports(importJobs);
      setProducts(productProfiles);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '资料库加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setSelectedIds([]); void load(viewScope); }, [viewScope]);
  useEffect(() => {
    const hasActiveImport = imports.some((job) => ['importing', 'extracting', 'analyzing', 'grouping'].includes(job.status));
    if (!hasActiveImport) return;
    const timer = window.setInterval(() => {
      void knowledgeApi.listImports().then(setImports).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [imports]);

  const reviewableImports = useMemo(() => imports.filter((job) => job.status === 'waiting_review' || job.status === 'failed'), [imports]);
  const activeImportCount = useMemo(() => imports.filter((job) => ['importing', 'extracting', 'analyzing', 'grouping'].includes(job.status)).length, [imports]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const business = entryBusinessCategory(entry);
      const haystack = [
        entry.layer,
        entry.category,
        business,
        entry.title,
        entry.content,
        entry.version,
        String(entry.structuredData?.sourceFileName ?? ''),
        JSON.stringify(entry.structuredData?.sourceReferences ?? ''),
      ].join('\n').toLowerCase();
      return (businessFilter === 'all' || business === businessFilter)
        && (!keyword || haystack.includes(keyword));
    });
  }, [entries, businessFilter, query]);

  const productMode = viewScope === 'active' && businessFilter === '产品资料';
  const unmatchedProductEntries = useMemo(() => entries.filter((entry) => entryBusinessCategory(entry) === '产品资料' && !entry.productId && !entry.deletedAt), [entries]);

  const selectableVisible = productMode ? [] : visible.filter((entry) => !isLockedEntry(entry));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((entry) => selectedIds.includes(entry.id));

  const toggleSelection = (id: string) => setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const toggleAllVisible = () => setSelectedIds((ids) => allVisibleSelected ? ids.filter((id) => !selectableVisible.some((entry) => entry.id === id)) : [...new Set([...ids, ...selectableVisible.map((entry) => entry.id)])]);

  const trashSelected = async (ids = selectedIds) => {
    if (ids.length === 0 || !window.confirm(`确认将 ${ids.length} 条资料移入回收站？30天内可以恢复。`)) return;
    try { setBatchBusy(true); await knowledgeApi.trash(ids); setSelectedIds([]); await load('active'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '删除失败'); }
    finally { setBatchBusy(false); }
  };

  const restoreSelected = async (ids = selectedIds) => {
    if (ids.length === 0) return;
    try { setBatchBusy(true); await knowledgeApi.restore(ids); setSelectedIds([]); await load('trash'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '恢复失败'); }
    finally { setBatchBusy(false); }
  };

  const purgeOne = async (entry: KnowledgeEntry) => {
    if (!window.confirm(`彻底删除“${entry.title}”？此操作无法恢复。`)) return;
    try { setBatchBusy(true); await knowledgeApi.purge(entry.id); setSelectedIds((ids) => ids.filter((id) => id !== entry.id)); await load('trash'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '彻底删除失败'); }
    finally { setBatchBusy(false); }
  };

  const downloadExport = async (format: 'excel' | 'json' | 'markdown') => {
    try {
      const exported = await knowledgeApi.exportFile(format);
      const url = URL.createObjectURL(exported.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出失败');
    }
  };

  return <main className="knowledge-page">
    <header className="knowledge-header">
      <div>
        <span>企业知识与销售规则</span>
        <h1>{viewScope === 'active' ? '资料库' : '回收站'}</h1>
        <p>导入产品、案例和销售资料，AI 会拆分整理成候选条目；原始图片与视频会完整保留，人工确认后才进入智能体检索。</p>
      </div>
      <div className="knowledge-actions">
        {viewScope === 'active' ? <>
          <button className="primary-button" onClick={() => setShowImportWizard(true)}><UploadIcon /> 导入资料</button>
          <button className="secondary-button pending-review-button" disabled={reviewableImports.length === 0} onClick={() => setReviewJob(reviewableImports[0] ?? null)}>待确认 {reviewableImports.length}</button>
          {activeImportCount > 0 && <span className="knowledge-import-progress">正在解析 {activeImportCount} 批资料</span>}
          <button className="secondary-button" onClick={() => productMode ? setOpenProductForm(true) : setOpenForm(true)}><PlusIcon /> {productMode ? '新建产品' : '手动新增'}</button>
        </> : null}
        <button className="secondary-button" onClick={() => setViewScope((scope) => scope === 'active' ? 'trash' : 'active')}>{viewScope === 'active' ? '回收站' : '返回资料库'}</button>
        <div className="export-menu">
          <button className="secondary-button" aria-expanded={exportOpen} onClick={() => setExportOpen((value) => !value)}>导出资料库</button>
          {exportOpen && <div className="export-menu-panel">
            <button onClick={() => void downloadExport('excel')}>Excel 表格</button>
            <button onClick={() => void downloadExport('markdown')}>Markdown 文档</button>
            <button onClick={() => void downloadExport('json')}>JSON 数据</button>
          </div>}
        </div>
        <button className="secondary-button" onClick={onBack}>返回工作台</button>
      </div>
    </header>

    {error && <div className="workspace-error" role="alert">{error}</div>}

    {selectableVisible.length > 0 && <div className="knowledge-batch-bar">
      <label><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> 全选当前筛选结果</label>
      <span>已选择 {selectedIds.length} 条</span>
      {viewScope === 'active'
        ? <button disabled={batchBusy || selectedIds.length === 0} onClick={() => void trashSelected()}>移入回收站</button>
        : <button disabled={batchBusy || selectedIds.length === 0} onClick={() => void restoreSelected()}>批量恢复</button>}
    </div>}

    <div className="knowledge-filter-groups">
      <div className="knowledge-search-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文、分类、来源文件…" />
        <span>{visible.length} 条结果</span>
      </div>
      <div className="knowledge-filters">
        <button className={businessFilter === 'all' ? 'active' : ''} onClick={() => setBusinessFilter('all')}>全部归档</button>
        {defaultBusinessCategories.map((category) => <button className={businessFilter === category ? 'active' : ''} onClick={() => setBusinessFilter(category)} key={category}>{category}</button>)}
      </div>
    </div>

    {productMode ? <ProductCatalog products={products} query={query} unmatchedCount={unmatchedProductEntries.length} onOpen={async (id) => { try { setProductDetail(await productApi.get(id)); } catch (caught) { setError(caught instanceof Error ? caught.message : '产品档案加载失败'); } }} onOpenUnmatched={() => setShowUnmatched(true)} /> : <section className="knowledge-table">
      <header><span>分类与名称</span><span>内容摘要</span><span>版本与状态</span><span>操作</span></header>
      {loading ? <div className="knowledge-loading">正在加载资料库…</div> : visible.map((entry) => <KnowledgeRow key={entry.id} entry={entry} scope={viewScope} selected={selectedIds.includes(entry.id)} onToggle={() => toggleSelection(entry.id)} onOpen={() => setDetailEntry(entry)} onChanged={load} onTrash={() => void trashSelected([entry.id])} onRestore={() => void restoreSelected([entry.id])} onPurge={() => void purgeOne(entry)} />)}
      {!loading && visible.length === 0 && <div className="knowledge-loading">当前筛选下暂无资料。</div>}
    </section>}

    {openForm && <KnowledgeForm businessCategories={[...defaultBusinessCategories]} onClose={() => setOpenForm(false)} onCreated={async () => { setOpenForm(false); await load(); }} />}
    {openProductForm && <ProductForm onClose={() => setOpenProductForm(false)} onCreated={async () => { setOpenProductForm(false); await load(); }} />}
    {productDetail && <ProductDetailModal detail={productDetail} onClose={() => setProductDetail(null)} onOpenEntry={(entry) => { setProductDetail(null); setDetailEntry(entry); }} onChanged={async () => { const refreshed = await productApi.get(productDetail.product.id); setProductDetail(refreshed); await load(); }} />}
    {showUnmatched && <UnmatchedProductModal entries={unmatchedProductEntries} products={products} onClose={() => setShowUnmatched(false)} onOpenEntry={(entry) => { setShowUnmatched(false); setDetailEntry(entry); }} onChanged={async () => { await load(); }} />}
    {detailEntry && <KnowledgeDetailModal entry={detailEntry} businessCategories={[...defaultBusinessCategories]} onClose={() => setDetailEntry(null)} onSaved={async (entry) => { setDetailEntry(entry); await load(); }} />}
    {showImportWizard && <ImportWizard products={products} onClose={() => setShowImportWizard(false)} onCreated={async (job) => { setShowImportWizard(false); setReviewJob(job.status === 'waiting_review' || job.status === 'failed' ? job : null); await load(); }} />}
    {reviewJob && <ImportReviewModal key={reviewJob.id} job={reviewJob} imports={imports} products={products} businessCategories={[...defaultBusinessCategories]} onSelectJob={setReviewJob} onClose={() => setReviewJob(null)} onFinished={async () => { setReviewJob(null); await load(); }} />}
  </main>;
}

function ProductCatalog({ products, query, unmatchedCount, onOpen, onOpenUnmatched }: { products: ProductProfileView[]; query: string; unmatchedCount: number; onOpen: (id: string) => void; onOpenUnmatched: () => void }) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'archived'>('all');
  const keyword = query.trim().toLowerCase();
  const visible = products.filter((product) => (statusFilter === 'all' || product.status === statusFilter) && (!keyword || [product.name, product.positioning, product.targetCustomers, product.tags.join(' ')].join('\n').toLowerCase().includes(keyword)));
  return <section className="product-catalog" aria-label="产品档案">
    <header><div><strong>产品档案</strong><span>先选择产品，再查看它的套餐、卖点、媒体和知识明细</span></div><div className="product-status-filters"><button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>全部</button><button className={statusFilter === 'published' ? 'active' : ''} onClick={() => setStatusFilter('published')}>已发布</button><button className={statusFilter === 'draft' ? 'active' : ''} onClick={() => setStatusFilter('draft')}>草稿</button><button className={statusFilter === 'archived' ? 'active' : ''} onClick={() => setStatusFilter('archived')}>已归档</button><em>{visible.length} 个产品</em></div></header>
    <div className="product-card-grid">
      {visible.map((product) => {
        const coverUrl = product.cover ? knowledgeApi.mediaUrl(product.cover.entryId, product.cover.mediaId) : '';
        return <button className="product-profile-card" key={product.id} onClick={() => onOpen(product.id)}>
          <div className={`product-card-cover${coverUrl ? ' has-image' : ''}`}>{coverUrl ? <img src={coverUrl} alt="" /> : <span>{product.name.slice(0, 1)}</span>}<em className={product.status}>{product.status === 'published' ? '已发布' : product.status === 'archived' ? '已归档' : '草稿'}</em></div>
          <div className="product-card-content"><h3>{product.name}</h3><p>{product.positioning || '尚未填写一句话定位，建议进入产品档案补充。'}</p><div className="product-card-metrics"><span><b>{product.packages.length}</b> 套餐/规格</span><span><b>{product.knowledgeCount}</b> 条资料</span><span><b>{product.mediaCount}</b> 个媒体</span></div><div className="product-completeness"><span><i style={{ width: `${product.completeness}%` }} /></span><em>资料完整度 {product.completeness}%</em></div></div>
        </button>;
      })}
      {unmatchedCount > 0 && <button className="product-profile-card unmatched" onClick={onOpenUnmatched}><div className="product-card-cover"><span>待</span><em>需整理</em></div><div className="product-card-content"><h3>待整理资料</h3><p>这些资料尚未确认属于哪个产品，整理后才会进入对应产品档案。</p><div className="product-card-metrics"><span><b>{unmatchedCount}</b> 条未归属资料</span></div><strong className="product-card-link">立即整理 →</strong></div></button>}
    </div>
    {visible.length === 0 && unmatchedCount === 0 && <div className="product-empty"><strong>还没有产品档案</strong><p>点击顶部“新建产品”，或导入包含明确产品名称的资料。</p></div>}
  </section>;
}

function ProductForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> | void }) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [positioning, setPositioning] = useState('');
  const [targetCustomers, setTargetCustomers] = useState('');
  const [packages, setPackages] = useState<ProductPackage[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const addPackage = () => setPackages((items) => [...items, { id: crypto.randomUUID(), name: '', priceDescription: '', applicableConditions: '' }]);
  const submit = async () => { try { setSaving(true); setError(''); await productApi.create({ name, aliases: aliases.split(/[，,]/).map((item) => item.trim()).filter(Boolean), positioning, targetCustomers, packages: packages.filter((item) => item.name.trim()), tags: [], status: 'draft' }); await onCreated(); } catch (caught) { setError(caught instanceof Error ? caught.message : '产品创建失败'); } finally { setSaving(false); } };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="knowledge-modal product-form-modal" role="dialog" aria-modal="true" aria-labelledby="product-form-title"><header><div><h2 id="product-form-title">新建产品档案</h2><p>先建立产品，再将导入资料归入对应产品与套餐。</p></div><button onClick={onClose} aria-label="关闭">×</button></header>{error && <div className="workspace-error">{error}</div>}<div className="product-editor-form"><label><span>产品名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：2天企业AI培训课程" /></label><label><span>别名</span><input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="多个别名用逗号分隔" /></label><label className="wide"><span>一句话定位</span><textarea value={positioning} onChange={(event) => setPositioning(event.target.value)} placeholder="用一句话说明产品帮助谁、解决什么问题" /></label><label className="wide"><span>适用客户</span><textarea value={targetCustomers} onChange={(event) => setTargetCustomers(event.target.value)} placeholder="例如：希望在企业内部落地AI流程的老板与管理团队" /></label><div className="product-package-editor wide"><div><strong>套餐 / 规格</strong><button type="button" onClick={addPackage}><PlusIcon /> 添加套餐</button></div>{packages.length === 0 && <p>可稍后添加基础版、企业版或定制方案。</p>}{packages.map((item, index) => <div className="package-edit-row" key={item.id}><input value={item.name} onChange={(event) => setPackages((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} placeholder="套餐名称" /><input value={item.priceDescription ?? ''} onChange={(event) => setPackages((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, priceDescription: event.target.value } : entry))} placeholder="价格说明" /><input value={item.applicableConditions ?? ''} onChange={(event) => setPackages((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, applicableConditions: event.target.value } : entry))} placeholder="适用条件" /><button onClick={() => setPackages((items) => items.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>)}</div></div><footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !name.trim()} onClick={() => void submit()}>{saving ? '正在创建…' : '创建产品档案'}</button></footer></section></div>;
}

function ProductDetailModal({ detail, onClose, onOpenEntry, onChanged }: { detail: ProductProfileDetail; onClose: () => void; onOpenEntry: (entry: KnowledgeEntry) => void; onChanged: () => Promise<void> }) {
  const { product, entries, media } = detail;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(product.name);
  const [aliases, setAliases] = useState(product.aliases.join('，'));
  const [positioning, setPositioning] = useState(product.positioning);
  const [targetCustomers, setTargetCustomers] = useState(product.targetCustomers);
  const [packages, setPackages] = useState<ProductPackage[]>(product.packages);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const grouped: Record<string, KnowledgeEntry[]> = {
    '核心价值与卖点': [],
    '价格及适用条件': [],
    '常见问题与标准回答': [],
    '服务、售后与禁用表达': [],
  };
  entries.forEach((entry) => {
    const titleAndCategory = `${entry.category}${entry.title}`;
    const searchable = `${titleAndCategory}${entry.content}`;
    if (/服务|售后|承诺|禁用|红线|边界|禁止/.test(searchable)) grouped['服务、售后与禁用表达'].push(entry);
    else if (/价格|报价|规格|套餐|版本|参数/.test(searchable)) grouped['价格及适用条件'].push(entry);
    else if (/问题|回答|话术|使用|饮用|说明/.test(titleAndCategory)) grouped['常见问题与标准回答'].push(entry);
    else grouped['核心价值与卖点'].push(entry);
  });
  const save = async () => { try { setBusy(true); await productApi.update(product.id, { name, aliases: aliases.split(/[，,]/).map((item) => item.trim()).filter(Boolean), positioning, targetCustomers, packages: packages.filter((item) => item.name.trim()) }); setEditing(false); await onChanged(); } finally { setBusy(false); } };
  const changeStatus = async (status: 'draft' | 'published' | 'archived') => { try { setBusy(true); await productApi.update(product.id, { status }); await onChanged(); } finally { setBusy(false); } };
  const uploadMedia = async (files: File[]) => { try { setBusy(true); for (const file of files.filter((item) => item.size <= 25 * 1024 * 1024)) await productApi.uploadMedia(product.id, file); await onChanged(); } finally { setBusy(false); if (mediaInputRef.current) mediaInputRef.current.value = ''; } };
  const deleteMedia = async (asset: ProductProfileDetail['media'][number]) => {
    if (!window.confirm(`确定删除“${asset.name}”吗？删除后将不再显示在产品档案中。`)) return;
    try { setBusy(true); await productApi.deleteMedia(product.id, asset.id); await onChanged(); } finally { setBusy(false); }
  };
  const setCover = async (asset: ProductProfileDetail['media'][number]) => {
    try {
      setBusy(true);
      setActionError('');
      setActionMessage('');
      await productApi.update(product.id, { cover: { entryId: asset.entryId, mediaId: asset.id } });
      await onChanged();
      setActionMessage(`已将“${asset.name}”设为产品封面`);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '设置封面失败');
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop product-detail-backdrop" role="presentation"><section className="product-detail-modal" role="dialog" aria-modal="true" aria-labelledby="product-detail-title"><header className="product-detail-header"><div><span>产品档案</span><h2 id="product-detail-title">{product.name}</h2><p>{product.positioning || '尚未填写产品定位'}</p></div><div><span className={`product-status ${product.status}`}>{product.status === 'published' ? '已发布' : product.status === 'archived' ? '已归档' : '草稿'}</span><input ref={mediaInputRef} className="visually-hidden" type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => void uploadMedia(Array.from(event.target.files ?? []))} /><button className="secondary-button" disabled={busy} onClick={() => mediaInputRef.current?.click()}><UploadIcon /> 上传素材</button><button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? '取消修改' : '修改档案'}</button>{product.status !== 'published' && <button className="primary-button" disabled={busy} onClick={() => void changeStatus('published')}>发布产品</button>}{product.status === 'published' && <button className="secondary-button" disabled={busy} onClick={() => void changeStatus('archived')}>归档产品</button>}<button className="detail-close" onClick={onClose} aria-label="关闭">×</button></div></header><div className="product-detail-scroll">
    {(actionMessage || actionError) && <div className={`product-action-notice ${actionError ? 'error' : 'success'}`} role={actionError ? 'alert' : 'status'}>{actionError || actionMessage}</div>}
    {editing ? <div className="product-editor-form product-detail-editor"><label><span>产品名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>别名</span><input value={aliases} onChange={(event) => setAliases(event.target.value)} /></label><label className="wide"><span>一句话定位</span><textarea value={positioning} onChange={(event) => setPositioning(event.target.value)} /></label><label className="wide"><span>适用客户</span><textarea value={targetCustomers} onChange={(event) => setTargetCustomers(event.target.value)} /></label><div className="product-package-editor wide"><div><strong>套餐 / 规格</strong><button onClick={() => setPackages((items) => [...items, { id: crypto.randomUUID(), name: '' }])}><PlusIcon /> 添加套餐</button></div>{packages.map((item, index) => <div className="package-edit-row" key={item.id}><input value={item.name} onChange={(event) => setPackages((items) => items.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry))} placeholder="套餐名称" /><input value={item.priceDescription ?? ''} onChange={(event) => setPackages((items) => items.map((entry, i) => i === index ? { ...entry, priceDescription: event.target.value } : entry))} placeholder="价格说明" /><input value={item.applicableConditions ?? ''} onChange={(event) => setPackages((items) => items.map((entry, i) => i === index ? { ...entry, applicableConditions: event.target.value } : entry))} placeholder="适用条件" /><button onClick={() => setPackages((items) => items.filter((_, i) => i !== index))}>删除</button></div>)}</div><button className="primary-button product-save" disabled={busy || !name.trim()} onClick={() => void save()}>保存修改</button></div> : <>
      <section className="product-overview-grid"><article><span>适用客户</span><p>{product.targetCustomers || '尚未补充适用客户'}</p></article><article><span>资料完整度</span><strong>{product.completeness}%</strong><div className="product-completeness"><span><i style={{ width: `${product.completeness}%` }} /></span></div></article><article><span>资料概况</span><p>{product.knowledgeCount} 条知识 · {product.mediaCount} 个图片/视频</p></article></section>
      <ProductSection title="套餐与规格" empty="尚未添加套餐或规格">{product.packages.length > 0 ? <div className="product-package-grid">{product.packages.map((item) => <article key={item.id}><strong>{item.name}</strong><p>{item.priceDescription || '价格待补充'}</p><span>{item.applicableConditions || '适用条件待补充'}</span></article>)}</div> : null}</ProductSection>
      {Object.entries(grouped).map(([title, sectionEntries]) => <ProductSection title={title} empty="该部分尚未整理资料" key={title}>{sectionEntries.length > 0 ? <div className="product-knowledge-list">{sectionEntries.map((entry) => <button onClick={() => onOpenEntry(entry)} key={entry.id}><span><em>{entry.layer}</em><strong>{entry.title}</strong></span><p>{String(entry.structuredData?.analysisSummary ?? entry.content)}</p><i>查看资料 →</i></button>)}</div> : null}</ProductSection>)}
      <ProductSection title="图片、视频及宣传素材" empty="尚未上传产品图片或视频">{media.length > 0 ? <div className="product-media-gallery">{media.map((asset) => { const isCover = product.cover?.entryId === asset.entryId && product.cover.mediaId === asset.id; return <figure className={isCover ? 'is-cover' : ''} key={`${asset.entryId}-${asset.id}`}>{asset.kind === 'video' ? <video src={asset.importJobId && asset.sourceFileId ? knowledgeApi.importSourceUrl(asset.importJobId, asset.sourceFileId) : knowledgeApi.mediaUrl(asset.entryId, asset.id)} controls preload="metadata" /> : <img src={asset.importJobId && asset.sourceFileId ? knowledgeApi.importSourceUrl(asset.importJobId, asset.sourceFileId) : knowledgeApi.mediaUrl(asset.entryId, asset.id)} alt={asset.name} loading="lazy" />}{isCover && <strong className="cover-badge">当前封面</strong>}<figcaption><span title={asset.name}>{asset.name}</span><div>{asset.kind === 'image' && <button className={isCover ? 'cover-button active' : 'cover-button'} disabled={busy || isCover} onClick={() => void setCover(asset)}>{isCover ? '当前封面' : busy ? '设置中…' : '设为封面'}</button>}<button className="media-delete-button" disabled={busy} aria-label={`删除${asset.name}`} onClick={() => void deleteMedia(asset)}>删除</button></div></figcaption></figure>; })}</div> : null}</ProductSection>
      <ProductSection title="资料明细" empty="暂无关联知识条目">{entries.length > 0 ? <div className="product-raw-entries">{entries.map((entry) => <button key={entry.id} onClick={() => onOpenEntry(entry)}><span className={`status-badge ${entry.status}`}>{entry.status === 'published' ? '已发布' : entry.status === 'archived' ? '已归档' : '草稿'}</span><strong>{entry.title}</strong><em>{entry.category}</em></button>)}</div> : null}</ProductSection>
    </>}</div></section></div>;
}

function ProductSection({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  return <section className="product-detail-section"><header><h3>{title}</h3></header>{children || <p className="product-section-empty">{empty}</p>}</section>;
}

function UnmatchedProductModal({ entries, products, onClose, onOpenEntry, onChanged }: { entries: KnowledgeEntry[]; products: ProductProfileView[]; onClose: () => void; onOpenEntry: (entry: KnowledgeEntry) => void; onChanged: () => Promise<void> }) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState('');
  const link = async (entry: KnowledgeEntry) => { const productId = targets[entry.id]; if (!productId) return; try { setBusyId(entry.id); await productApi.linkKnowledge(productId, [entry.id]); await onChanged(); } finally { setBusyId(''); } };
  return <div className="modal-backdrop" role="presentation"><section className="knowledge-modal unmatched-product-modal" role="dialog" aria-modal="true" aria-labelledby="unmatched-title"><header><div><h2 id="unmatched-title">待整理产品资料</h2><p>确认资料属于哪个产品后，才会显示在对应产品档案中；不属于产品的资料请调整分类。</p></div><button onClick={onClose} aria-label="关闭">×</button></header><div className="unmatched-entry-list">{entries.map((entry) => <article key={entry.id}><div><strong>{entry.title}</strong><p>{entry.content}</p><span>{entry.category} · {originLabel(entry)}</span></div><select value={targets[entry.id] ?? ''} onChange={(event) => setTargets((current) => ({ ...current, [entry.id]: event.target.value }))}><option value="">选择归属产品</option>{products.filter((product) => product.status !== 'archived').map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select><div className="unmatched-entry-actions"><button className="secondary-button" onClick={() => onOpenEntry(entry)}>调整分类</button><button className="primary-button" disabled={!targets[entry.id] || busyId === entry.id} onClick={() => void link(entry)}>{busyId === entry.id ? '正在归入…' : '确认归入'}</button></div></article>)}</div><footer><button className="secondary-button" onClick={onClose}>完成整理</button></footer></section></div>;
}

function KnowledgeRow({ entry, scope, selected, onToggle, onOpen, onChanged, onTrash, onRestore, onPurge }: { entry: KnowledgeEntry; scope: 'active' | 'trash'; selected: boolean; onToggle: () => void; onOpen: () => void; onChanged: () => Promise<void>; onTrash: () => void; onRestore: () => void; onPurge: () => void }) {
  const [busy, setBusy] = useState(false);
  const locked = isLockedEntry(entry);
  const needsReview = entry.status === 'in_review' && Boolean(entry.structuredData?.requiresHumanConfirmation);
  const updateStatus = async (action: 'publish' | 'archive') => {
    try { setBusy(true); await knowledgeApi[action](entry.id); await onChanged(); } finally { setBusy(false); }
  };
  const copySystem = async () => {
    try { setBusy(true); await knowledgeApi.copySystem(entry.id); await onChanged(); } finally { setBusy(false); }
  };
  return <article className="clickable-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(); }}>
    <div>{!locked && <input className="knowledge-row-check" type="checkbox" checked={selected} aria-label={`选择${entry.title}`} onClick={(event) => event.stopPropagation()} onChange={onToggle} />}<em className={`layer-badge ${entry.layer.toLowerCase()}`}>{entry.layer}</em><span><strong>{entry.title}</strong><small>{entryBusinessCategory(entry)} · <b className={`origin-badge ${entry.origin ?? 'manual'}`}>{originLabel(entry)}</b></small></span></div>
    <p>{String(entry.structuredData?.analysisSummary ?? entry.content)}</p>
    <div><span className={`status-badge ${entry.status}`}>{scope === 'trash' ? '回收站' : needsReview ? '待确认归类' : entry.status === 'published' ? '已发布' : entry.status === 'in_review' ? '待审核' : entry.status === 'archived' ? '已归档' : '草稿'}</span><small>{entry.version}</small>{entry.purgeAt && <small>{new Date(entry.purgeAt).toLocaleDateString()} 后清理</small>}</div>
    <div className="knowledge-row-actions" onClick={(event) => event.stopPropagation()}>{locked ? <><span className="locked"><ShieldIcon /> 系统锁定</span><button disabled={busy} onClick={() => void copySystem()}>复制为企业条目</button></> : scope === 'trash' ? <><button disabled={busy} onClick={onRestore}>恢复</button><button className="danger-text-button" disabled={busy} onClick={onPurge}>彻底删除</button></> : <>{entry.status !== 'published' && <button disabled={busy || needsReview} onClick={() => void updateStatus('publish')}><CheckIcon /> 发布</button>}{entry.status !== 'archived' && <button disabled={busy} onClick={() => void updateStatus('archive')}>归档</button>}<button className="danger-text-button" disabled={busy} onClick={onTrash}>删除</button></>}</div>
  </article>;
}

function KnowledgeDetailModal({ entry, businessCategories, onClose, onSaved }: { entry: KnowledgeEntry; businessCategories: string[]; onClose: () => void; onSaved: (entry: KnowledgeEntry) => Promise<void> }) {
  const locked = isLockedEntry(entry) || Boolean(entry.deletedAt);
  const [tab, setTab] = useState<'preview' | 'edit' | 'source' | 'history'>('preview');
  const [title, setTitle] = useState(entry.title);
  const [category, setCategory] = useState(entry.category);
  const [businessCategory, setBusinessCategory] = useState(entryBusinessCategory(entry));
  const [content, setContent] = useState(entry.content);
  const [version, setVersion] = useState(entry.version);
  const [saving, setSaving] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [mediaNotice, setMediaNotice] = useState('');
  const [error, setError] = useState('');
  const mediaRef = useRef<HTMLInputElement>(null);
  const sources = Array.isArray(entry.structuredData?.sourceReferences) ? entry.structuredData.sourceReferences as Array<Record<string, unknown>> : [];
  const mediaAssets = entryMediaAssets(entry);

  const addMedia = async (files: File[]) => {
    if (files.some((file) => file.size > 25 * 1024 * 1024)) { setError('单个图片或视频不能超过 25MB'); return; }
    if (files.length === 0) return;
    try {
      setError('');
      setMediaNotice('');
      setUploadingMedia(true);
      setUploadingNames(files.map((file) => file.name));
      let updated = entry;
      for (const file of files) updated = await knowledgeApi.uploadMedia(entry.id, file);
      await onSaved(updated);
      setMediaNotice(`已成功保存 ${files.length} 个素材`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '媒体素材上传失败');
    } finally {
      setUploadingMedia(false);
      setUploadingNames([]);
      if (mediaRef.current) mediaRef.current.value = '';
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      const nextStructuredData = { ...entry.structuredData, businessCategory };
      const updated = await knowledgeApi.update(entry.id, { title, category, content, version, structuredData: nextStructuredData });
      setTab('preview');
      await onSaved(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="knowledge-modal knowledge-detail-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-detail-title">
      <header>
        <div>
          <h2 id="knowledge-detail-title">资料条目</h2>
          <p>{entry.layer} · {entry.status === 'published' ? '已发布' : entry.status === 'archived' ? '已归档' : entry.status === 'draft' ? '草稿' : '待审核'} · 版本 {entry.version}</p>
        </div>
        <button onClick={onClose} aria-label="关闭">×</button>
      </header>
      {error && <div className="workspace-error">{error}</div>}
      <div className="knowledge-detail-body">
        <div className="knowledge-detail-tabs">
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>预览</button>
          <button className={tab === 'edit' ? 'active' : ''} disabled={locked} onClick={() => setTab('edit')}>编辑</button>
          <button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}>来源</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>历史</button>
        </div>
        <div className="knowledge-detail-meta">
          <span className={`status-badge ${entry.status}`}>{entry.status === 'published' ? '已发布' : entry.status === 'archived' ? '已归档' : entry.status === 'draft' ? '草稿' : '待审核'}</span>
          <span>{locked ? '系统锁定，只能预览' : '可预览并修改'}</span>
          <span>更新时间：{new Date(entry.updatedAt).toLocaleString()}</span>
        </div>

        {tab === 'preview' && <div className="knowledge-preview">
          <h3>{entry.title}</h3>
          <div><strong>分类</strong><span>{entryBusinessCategory(entry)} / {entry.category}</span></div>
          <div><strong>正文</strong><p>{entry.content}</p></div>
          {mediaAssets.length > 0 && <div><strong>图片与视频</strong><MediaGallery assets={mediaAssets} urlFor={(asset) => asset.importJobId && asset.sourceFileId ? knowledgeApi.importSourceUrl(asset.importJobId, asset.sourceFileId) : knowledgeApi.mediaUrl(entry.id, asset.id)} /></div>}
        </div>}

        {tab === 'edit' && !locked && <div className="knowledge-form-grid detail-form">
          <label><span>业务归档</span><select value={businessCategory} onChange={(event) => setBusinessCategory(event.target.value)}>{businessCategories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
          <label><span>细分类</span><input value={category} onChange={(event) => setCategory(event.target.value)} /></label>
          <label className="wide"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>版本号</span><input value={version} onChange={(event) => setVersion(event.target.value)} /></label>
          <label className="wide"><span>正文内容</span><textarea value={content} onChange={(event) => setContent(event.target.value)} /></label>
          {(businessCategory === '产品资料' || businessCategory === '客户案例') && <>
            <label className="wide media-upload-field"><span>添加图片与视频</span><input ref={mediaRef} type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => void addMedia(Array.from(event.target.files ?? []))} /><small>选择后会立即上传并保存；支持图片、MP4、MOV、WebM，单个不超过 25MB。</small>{uploadingMedia && <small className="media-upload-progress">正在保存：{uploadingNames.join('、')}</small>}{mediaNotice && !uploadingMedia && <small className="media-upload-success">✓ {mediaNotice}</small>}</label>
            <section className="wide saved-media-panel" aria-label="已上传素材">
              <header><div><strong>已上传素材</strong><span>上传成功后会显示在这里</span></div><em>{mediaAssets.length} 个文件已保存</em></header>
              {mediaAssets.length > 0 ? <MediaGallery assets={mediaAssets} urlFor={(asset) => asset.importJobId && asset.sourceFileId ? knowledgeApi.importSourceUrl(asset.importJobId, asset.sourceFileId) : knowledgeApi.mediaUrl(entry.id, asset.id)} /> : <p>暂未上传图片或视频</p>}
            </section>
          </>}
        </div>}

        {tab === 'source' && <div className="knowledge-preview">
          <h3>来源依据</h3>
          {sources.length > 0 ? <div><strong>引用片段</strong><ul>{sources.map((source, index) => <li key={`${String(source.sourceFileName ?? 'source')}-${index}`}><b>{String(source.sourceFileName ?? '来源文件')}</b>{source.location ? ` · ${String(source.location)}` : ''}<p>{String(source.excerpt ?? '')}</p></li>)}</ul></div> : <div><strong>暂无来源</strong><p>{String(entry.structuredData?.sourceFileName ?? '该条目可能为手动创建或系统内置，暂未记录来源文件。')}</p></div>}
        </div>}

        {tab === 'history' && <div className="knowledge-preview">
          <h3>变更记录</h3>
          <div><strong>创建时间</strong><span>{new Date(entry.createdAt).toLocaleString()}</span></div>
          <div><strong>最近更新</strong><span>{new Date(entry.updatedAt).toLocaleString()}</span></div>
          <div><strong>审核发布</strong><span>{entry.reviewer ? `${entry.reviewer} · ${entry.publishedAt ? new Date(entry.publishedAt).toLocaleString() : '未记录发布时间'}` : '尚未发布或未记录审核人'}</span></div>
        </div>}
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose}>关闭</button>
        {tab === 'edit' && !locked && <button className="primary-button" disabled={saving || !title.trim() || !content.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存修改'}</button>}
        {tab !== 'edit' && !locked && <button className="primary-button" onClick={() => setTab('edit')}>修改内容</button>}
      </footer>
    </section>
  </div>;
}

const importPurposes: Array<{ value: KnowledgeImportContext['purpose']; title: string; description: string }> = [
  { value: 'auto', title: '自动判断', description: '文档、表格、图片等混合资料，由 AI 建议归档' },
  { value: 'product_media', title: '产品图片 / 视频', description: '保存到产品档案，并提取包装文字、规格和使用说明' },
  { value: 'customer_case', title: '客户案例图片 / 视频', description: '提取背景、过程、结果和适用边界，效果数据需人工确认' },
  { value: 'champion_chat', title: '销冠聊天截图', description: '多张截图组成一组对话，脱敏保存并拆出销售技巧' },
  { value: 'sales_video', title: '销售课程或复盘视频', description: '提取音频、关键画面、转写和带时间点的章节' },
  { value: 'other', title: '其他销售资料', description: '保留原文件，由 AI 拆条后人工选择归档位置' },
];

function ImportWizard({ products, onClose, onCreated }: { products: ProductProfileView[]; onClose: () => void; onCreated: (job: KnowledgeImportJob) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [purpose, setPurpose] = useState<KnowledgeImportContext['purpose']>('auto');
  const [sourceTitle, setSourceTitle] = useState('');
  const [productId, setProductId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const selectedProduct = products.find((product) => product.id === productId);

  const addFiles = (incoming: File[]) => {
    setError('');
    const rejected = incoming.find((file) => blockedPattern.test(file.name)
      || (file.type.startsWith('video/') ? file.size > 500 * 1024 * 1024 : file.size > 25 * 1024 * 1024));
    if (rejected) { setError(rejected.type.startsWith('video/') ? `${rejected.name} 超过500MB` : `${rejected.name} 超过25MB或文件类型不安全`); return; }
    if (purpose === 'champion_chat' && incoming.some((file) => !file.type.startsWith('image/'))) { setError('销冠聊天资料组只能上传图片截图'); return; }
    setFiles((current) => [...current, ...incoming].slice(0, 50));
  };
  const move = (index: number, offset: number) => setFiles((current) => {
    const target = index + offset;
    if (target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });
  const submit = async () => {
    if (files.length === 0) { setError('请先选择要导入的资料'); return; }
    if (purpose === 'product_media' && !productId) { setError('产品图片或视频需要先选择归属产品'); return; }
    const context: KnowledgeImportContext = { purpose, sourceTitle: sourceTitle.trim() || undefined, targetProductId: productId || undefined, targetPackageId: packageId || undefined, sourceGroupId: crypto.randomUUID() };
    try {
      setBusy(true); setError(''); setProgress(2);
      const largeVideos = files.filter((file) => file.type.startsWith('video/') && file.size > 24 * 1024 * 1024);
      const regularFiles = files.filter((file) => !largeVideos.includes(file));
      let latest: KnowledgeImportJob | undefined;
      if (regularFiles.length) { latest = await knowledgeApi.createImport(regularFiles, context); setProgress(Math.max(18, Math.round((regularFiles.length / files.length) * 100))); }
      for (let fileIndex = 0; fileIndex < largeVideos.length; fileIndex += 1) {
        const file = largeVideos[fileIndex]!;
        const chunkSize = 5 * 1024 * 1024;
        let job = await knowledgeApi.initializeChunkedImport(file, context, chunkSize);
        const totalChunks = Math.ceil(file.size / chunkSize);
        for (let index = 0; index < totalChunks; index += 1) {
          job = await knowledgeApi.uploadImportChunk(job.id, index, file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)));
          const completedUnits = regularFiles.length + fileIndex + ((index + 1) / totalChunks);
          setProgress(Math.min(96, Math.round((completedUnits / files.length) * 100)));
        }
        latest = await knowledgeApi.completeChunkedImport(job.id);
      }
      if (!latest) throw new Error('没有创建导入任务');
      setProgress(100);
      await onCreated(latest);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '资料导入失败'); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section className="knowledge-modal import-wizard" role="dialog" aria-modal="true" aria-labelledby="import-wizard-title">
      <header><div><h2 id="import-wizard-title">导入多媒体资料</h2><p>先说明资料用途，AI只负责识别和建议归类；人工确认后才会进入智能体检索。</p></div><button disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>
      {error && <div className="workspace-error">{error}</div>}
      <div className="import-wizard-content">
        <section><h3>1. 这批资料主要用于什么？</h3><div className="import-purpose-grid">{importPurposes.map((item) => <button type="button" className={purpose === item.value ? 'active' : ''} key={item.value} onClick={() => { setPurpose(item.value); if (item.value !== 'product_media') { setProductId(''); setPackageId(''); } }}><strong>{item.title}</strong><span>{item.description}</span></button>)}</div></section>
        <section className="import-context-fields"><h3>2. 补充归属信息</h3><label><span>资料组名称（可选）</span><input value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder={purpose === 'champion_chat' ? '例如：价格异议销冠对话复盘' : '例如：企业AI培训课程资料包'} /></label>{purpose === 'product_media' && <><label><span>归属产品</span><select value={productId} onChange={(event) => { setProductId(event.target.value); setPackageId(''); }}><option value="">请选择产品</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label><label><span>套餐 / 规格（可选）</span><select value={packageId} disabled={!selectedProduct} onChange={(event) => setPackageId(event.target.value)}><option value="">不关联具体套餐</option>{selectedProduct?.packages.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></>}</section>
        <section><h3>3. 上传并调整顺序</h3><div className={`import-drop-zone${dragging ? ' dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}><UploadIcon /><strong>拖拽图片、视频、文档或资料包到这里</strong><span>视频单个最多500MB，其他文件单个最多25MB；支持一次选择多个文件。</span><button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>选择文件</button><input ref={inputRef} className="visually-hidden" type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,.pdf,.docx,.pptx,.xlsx,.csv,.json,.md,.txt,.zip" onChange={(event) => addFiles(Array.from(event.target.files ?? []))} /></div>
          {files.length > 0 && <div className="import-file-queue">{files.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`}><em>{index + 1}</em><span><strong>{file.name}</strong><small>{file.type || '未知格式'} · {(file.size / 1024 / 1024).toFixed(1)} MB</small></span><button disabled={index === 0 || busy} onClick={() => move(index, -1)}>上移</button><button disabled={index === files.length - 1 || busy} onClick={() => move(index, 1)}>下移</button><button disabled={busy} className="danger-text" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>)}</div>}
        </section>
        {busy && <div className="import-upload-progress"><span><i style={{ width: `${progress}%` }} /></span><strong>{progress}%</strong><p>{progress < 100 ? '正在上传原文件，请不要关闭页面…' : '上传完成，后台开始识别内容。'}</p></div>}
      </div>
      <footer><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || files.length === 0} onClick={() => void submit()}>{busy ? '正在上传…' : `开始导入 ${files.length} 个文件`}</button></footer>
    </section>
  </div>;
}

function ImportReviewModal({ job, imports, products, businessCategories, onSelectJob, onClose, onFinished }: { job: KnowledgeImportJob; imports: KnowledgeImportJob[]; products: ProductProfileView[]; businessCategories: string[]; onSelectJob: (job: KnowledgeImportJob) => void; onClose: () => void; onFinished: () => Promise<void> }) {
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>(job.candidates);
  const [activeId, setActiveId] = useState(job.candidates.find((candidate) => candidate.reviewStatus !== 'discarded')?.id ?? job.candidates[0]?.id ?? '');
  const [activeSourceId, setActiveSourceId] = useState(job.sourceFiles[0]?.id ?? '');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const active = candidates.find((candidate) => candidate.id === activeId) ?? candidates[0];
  const activeSource = job.sourceFiles.find((file) => file.id === activeSourceId) ?? job.sourceFiles[0];
  const approvedCount = candidates.filter((candidate) => candidate.reviewStatus !== 'discarded').length;
  const revisionRoot = job.parentImportId ?? job.id;
  const relatedVersions = imports.filter((item) => item.id === revisionRoot || item.parentImportId === revisionRoot).sort((a, b) => (a.revisionNumber ?? 1) - (b.revisionNumber ?? 1));
  const reviewImportOptions = buildReviewImportOptions(imports);
  const selectedReviewImportId = reviewImportOptions.find((option) => {
    const item = imports.find((entry) => entry.id === option.id);
    return item && (item.parentImportId ?? item.id) === revisionRoot;
  })?.id ?? reviewImportOptions[0]?.id ?? '';
  const sectionById = new Map((job.documentSections ?? []).map((section) => [section.id, section]));

  const patchCandidate = (id: string, patch: Partial<KnowledgeCandidate>) => {
    setCandidates((items) => items.map((item) => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
  };

  const publish = async () => {
    try {
      setPublishing(true);
      setError('');
      await knowledgeApi.confirmImport(job.id, candidates);
      await onFinished();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认发布失败');
    } finally {
      setPublishing(false);
    }
  };

  const reparse = async () => {
    try {
      setPublishing(true);
      setError('');
      await knowledgeApi.reparseImport(job.id);
      await onFinished();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新完整解析失败');
    } finally { setPublishing(false); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="knowledge-modal import-review-modal" role="dialog" aria-modal="true" aria-labelledby="import-review-title">
      <header>
        <div>
          <h2 id="import-review-title">待确认资料</h2>
          <p>{job.sourceFiles.length} 个来源文件 · {approvedCount} 条候选内容，确认后才会进入智能体检索。</p>
        </div>
        <button onClick={onClose} aria-label="关闭">×</button>
      </header>
      {error && <div className="workspace-error">{error}</div>}
      <div className="import-coverage-summary">
        <label>待确认批次
          <select value={selectedReviewImportId} onChange={(event) => { const selected = imports.find((item) => item.id === event.target.value); if (selected) onSelectJob(selected); }}>
            {reviewImportOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label>解析版本
          <select value={job.id} onChange={(event) => { const selected = relatedVersions.find((item) => item.id === event.target.value); if (selected) onSelectJob(selected); }}>
            {relatedVersions.map((item) => <option value={item.id} key={item.id}>版本 {item.revisionNumber ?? 1} · {item.status}</option>)}
          </select>
        </label>
        <span><strong>{job.revision?.totalSections ?? job.documentSections?.length ?? 0}</strong> 原文章节</span>
        <span><strong>{approvedCount}</strong> 候选条目</span>
        <span className={(job.coveragePercentage ?? 0) >= 95 ? 'passed' : 'warning'}><strong>{job.coveragePercentage ?? 0}%</strong> 正文覆盖率</span>
        <span><strong>{job.revision?.pendingSections ?? 0}</strong> 待人工确认</span>
        <span><strong>{job.revision?.failedSections ?? 0}</strong> 解析失败</span>
      </div>
      <div className="import-review-body">
        <aside className="import-source-list">
          <strong>来源文件</strong>
          {job.sourceFiles.map((file, index) => <button className={file.id === activeSource?.id ? 'active' : ''} key={file.id} onClick={() => setActiveSourceId(file.id)}><em>{Number(file.sequenceIndex ?? index) + 1}</em><span>{file.name}</span><small>{file.mimeType.startsWith('video/') ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`} · {file.analysisStatus === 'needs_review' ? '待人工补充' : file.extractionMethod ?? file.status}</small></button>)}
        </aside>
        <div className="import-source-preview">
          <header><div><strong>原始内容与识别结果</strong><span>{activeSource?.name ?? '未选择来源文件'}</span></div>{activeSource?.privacyFindings?.length ? <em>{activeSource.privacyFindings.length} 项隐私提醒</em> : null}</header>
          {activeSource && <>
            {activeSource.mimeType.startsWith('image/') && <img className="import-source-image" src={knowledgeApi.importSourceUrl(job.id, activeSource.id)} alt={activeSource.name} />}
            {activeSource.mimeType.startsWith('video/') && <video className="import-source-video" src={knowledgeApi.importSourceUrl(job.id, activeSource.id)} controls preload="metadata" />}
            {!/^(image|video)\//.test(activeSource.mimeType) && <div className="import-document-placeholder"><strong>{activeSource.name}</strong><span>原始文档已安全保存，可在右侧逐条核对 AI 拆分结果。</span><a href={knowledgeApi.importSourceUrl(job.id, activeSource.id)} target="_blank" rel="noreferrer">打开原文件</a></div>}
            {(activeSource.transcript || job.transcript) && <section className="import-transcript"><strong>脱敏转写</strong><pre>{activeSource.transcript || job.transcript}</pre></section>}
            {activeSource.warnings.length > 0 && <section className="import-source-warnings"><strong>需要人工检查</strong>{activeSource.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</section>}
          </>}
        </div>
        <div className="import-candidate-column">
          <div className="import-candidate-picker"><strong>候选知识条目</strong>{candidates.map((candidate, index) => <button className={candidate.id === active?.id ? 'active' : ''} key={candidate.id} onClick={() => { setActiveId(candidate.id); if (candidate.sourceFileIds[0]) setActiveSourceId(candidate.sourceFileIds[0]); }}><em>{candidate.reviewStatus === 'discarded' ? '已删除' : `候选 ${index + 1}`}</em><span>{candidate.title}</span><small>{candidate.timeRange ? `${Math.floor(candidate.timeRange.startSeconds / 60)}:${String(Math.floor(candidate.timeRange.startSeconds % 60)).padStart(2, '0')}–${Math.floor(candidate.timeRange.endSeconds / 60)}:${String(Math.floor(candidate.timeRange.endSeconds % 60)).padStart(2, '0')}` : (candidate.sourceSectionIds ?? []).map((id) => sectionById.get(id)?.title).filter(Boolean).join('、') || '待确认来源章节'}</small></button>)}</div>
        {active ? <div className="import-review-editor">
          <div className="candidate-status-line"><span>置信度 {Math.round(active.confidence * 100)}%</span><span>{active.layer} · {active.businessCategory}</span></div>
          <div className="knowledge-form-grid detail-form">
            <label><span>业务归档</span><select value={String(active.businessCategory)} onChange={(event) => { const value = event.target.value as KnowledgeCandidate['businessCategory']; patchCandidate(active.id, { businessCategory: value, category: value, layer: value === '销售技巧' ? 'L2' : 'L3' }); }}>{businessCategories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            {active.businessCategory !== '销售技巧' && <>
              <label><span>归属产品</span><select value={active.suggestedProductId ?? ''} onChange={(event) => { const product = products.find((item) => item.id === event.target.value); patchCandidate(active.id, { suggestedProductId: product?.id, suggestedProductName: product?.name, suggestedPackageName: undefined, productMatchConfidence: product ? 1 : undefined }); }}><option value="">待整理资料（暂不归属）</option>{products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select><small>{active.suggestedProductName && !active.suggestedProductId ? `AI识别：${active.suggestedProductName}，尚未匹配产品档案` : active.suggestedProductId ? `匹配置信度 ${Math.round((active.productMatchConfidence ?? 1) * 100)}% · 需人工确认` : '未选择产品时会进入待整理资料'}</small></label>
              <label><span>套餐 / 规格</span><select value={active.suggestedPackageName ?? ''} disabled={!active.suggestedProductId} onChange={(event) => patchCandidate(active.id, { suggestedPackageName: event.target.value || undefined })}><option value="">不关联具体套餐</option>{products.find((item) => item.id === active.suggestedProductId)?.packages.map((item) => <option value={item.name} key={item.id}>{item.name}</option>)}</select></label>
            </>}
            <label className="wide"><span>标题</span><input value={active.title} onChange={(event) => patchCandidate(active.id, { title: event.target.value })} /></label>
            <label><span>细分类</span><input value={active.category} onChange={(event) => patchCandidate(active.id, { category: event.target.value })} /></label>
            <label><span>版本号</span><input value={active.version} onChange={(event) => patchCandidate(active.id, { version: event.target.value })} /></label>
            <label className="wide"><span>内容</span><textarea value={active.content} onChange={(event) => patchCandidate(active.id, { content: event.target.value, summary: event.target.value.slice(0, 220) })} /></label>
          </div>
          {active.conversationMessages?.length ? <div className="conversation-review"><strong>修正销售 / 客户角色与脱敏文字</strong>{active.conversationMessages.map((message, index) => <div key={`${message.sourceFileId}-${index}`}><select value={message.role} onChange={(event) => patchCandidate(active.id, { conversationMessages: active.conversationMessages?.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as typeof item.role } : item) })}><option value="sales">销售</option><option value="customer">客户</option><option value="unknown">待确认</option></select><textarea value={message.text} onChange={(event) => patchCandidate(active.id, { conversationMessages: active.conversationMessages?.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item) })} /></div>)}</div> : null}
          {active.privacyFindings?.length ? <div className="privacy-review"><ShieldIcon /><span>已识别并脱敏：{active.privacyFindings.join('、')}。发布前请再次核对。</span></div> : null}
          {active.analysisWarnings?.length ? <div className="candidate-warning-list">{active.analysisWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div> : null}
          <div className="candidate-citations">
            <strong>来源引用</strong>
            {active.citations.map((citation, index) => <p key={`${citation.sourceFileId}-${index}`}>{citation.sourceFileName}{citation.location ? ` · ${citation.location}` : ''}：{citation.excerpt}</p>)}
          </div>
          <button className="secondary-button danger-button" onClick={() => patchCandidate(active.id, { reviewStatus: active.reviewStatus === 'discarded' ? 'pending' : 'discarded' })}>{active.reviewStatus === 'discarded' ? '恢复候选' : '删除此候选'}</button>
        </div> : <div className="knowledge-loading">没有可审核候选条目。</div>}
        </div>
      </div>
      <footer>
        <button className="secondary-button" disabled={publishing} onClick={() => void reparse()}>重新完整解析</button>
        <button className="secondary-button" onClick={onClose}>稍后处理</button>
        <button className="primary-button" disabled={publishing || approvedCount === 0 || (job.coveragePercentage ?? 0) < 95} onClick={() => void publish()}>{publishing ? '正在发布…' : `确认并发布 ${approvedCount} 条`}</button>
      </footer>
    </section>
  </div>;
}

function KnowledgeForm({ businessCategories, onClose, onCreated }: { businessCategories: string[]; onClose: () => void; onCreated: () => void }) {
  const [layer, setLayer] = useState<'L2' | 'L3' | 'L4'>('L3');
  const [category, setCategory] = useState('产品资料');
  const [businessCategory, setBusinessCategory] = useState('产品资料');
  const [entityName, setEntityName] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState('1.0');
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      setSaving(true);
      const entry = await knowledgeApi.create({ layer, category, title, content, version, structuredData: { businessCategory, entityName: entityName.trim() || undefined } });
      for (const file of mediaFiles) await knowledgeApi.uploadMedia(entry.id, file);
      onCreated();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '创建失败'); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="knowledge-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-form-title">
      <header><div><h2 id="knowledge-form-title">新建知识条目</h2><p>创建后为草稿，需要审核发布前才能参与检索。</p></div><button onClick={onClose} aria-label="关闭">×</button></header>
      {error && <div className="workspace-error">{error}</div>}
      <div className="knowledge-form-grid">
        <label><span>业务归档</span><select value={businessCategory} onChange={(event) => { const value = event.target.value; setBusinessCategory(value); setCategory(value); setLayer(value === '销售技巧' ? 'L2' : 'L3'); }}>{businessCategories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        {(businessCategory === '产品资料' || businessCategory === '客户案例') && <label className="wide"><span>{businessCategory === '产品资料' ? '产品名称' : '案例名称 / 客户行业'}</span><input value={entityName} onChange={(event) => setEntityName(event.target.value)} placeholder={businessCategory === '产品资料' ? '例如：企业版销售助手' : '例如：制造业客户成交案例'} /></label>}
        <label><span>细分类名称</span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="默认可与业务归档一致，也可更细" /></label>
        <label className="wide"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：企业版价格政策" /></label>
        <label className="wide"><span>内容</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="填写可审核、可引用的明确内容。事实缺失时不要推测。" /></label>
        {(businessCategory === '产品资料' || businessCategory === '客户案例') && <label className="wide media-upload-field"><span>图片与视频</span><input type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => setMediaFiles(Array.from(event.target.files ?? []).filter((file) => file.size <= 25 * 1024 * 1024))} /><small>原图和原视频将完整保留；支持图片、MP4、MOV、WebM，单个不超过 25MB。</small>{mediaFiles.length > 0 && <small>已选择 {mediaFiles.length} 个媒体文件</small>}</label>}
        <label><span>版本号</span><input value={version} onChange={(event) => setVersion(event.target.value)} /></label>
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !title.trim() || !content.trim()} onClick={() => void submit()}>{saving ? '正在保存…' : '保存草稿'}</button></footer>
    </section>
  </div>;
}

function MediaGallery({ assets, urlFor, compact = false }: { assets: KnowledgeMediaAsset[]; urlFor: (asset: KnowledgeMediaAsset) => string; compact?: boolean }) {
  return <div className={`knowledge-media-grid${compact ? ' compact' : ''}`}>{assets.map((asset) => <figure key={asset.id}>
    {asset.kind === 'video' ? <video src={urlFor(asset)} controls preload="metadata" /> : <img src={urlFor(asset)} alt={asset.name} loading="lazy" />}
    {!compact && <figcaption><strong>{asset.name}</strong><span>{asset.kind === 'video' ? '视频' : '图片'} · {(asset.size / 1024 / 1024).toFixed(1)} MB</span></figcaption>}
  </figure>)}</div>;
}
