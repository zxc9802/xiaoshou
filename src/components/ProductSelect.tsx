import { useEffect, useMemo, useState } from 'react';
import type { ProductProfileView } from '../types/analysis';
import { productApi } from '../services/analysisApi';

function productOptions(products: ProductProfileView[]) {
  return products.flatMap((product) => product.packages.length
    ? product.packages.map((item) => ({ key: `${product.id}:${item.id}`, value: `${product.name} · ${item.name}`, label: `${product.name} · ${item.name}` }))
    : [{ key: product.id, value: product.name, label: product.name }]);
}

export function ProductSelect({ value, onChange, ariaLabel = '关联产品', emptyLabel = '关联产品（可选）' }: { value: string; onChange: (value: string) => void; ariaLabel?: string; emptyLabel?: string }) {
  const [products, setProducts] = useState<ProductProfileView[]>([]);
  useEffect(() => { void productApi.list('published').then(setProducts).catch(() => setProducts([])); }, []);
  const options = useMemo(() => productOptions(products), [products]);
  const hasCurrent = !value || options.some((option) => option.value === value);
  return <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
    <option value="">{emptyLabel}</option>
    {!hasCurrent && <option value={value}>{value}（历史关联）</option>}
    {options.map((option) => <option value={option.value} key={option.key}>{option.label}</option>)}
  </select>;
}
