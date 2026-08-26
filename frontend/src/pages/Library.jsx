import { useEffect, useState, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { getMedia, formatSize } from '../api.js';

export default function Library() {
  const { type } = useParams();
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') || '';
  const navigate = useNavigate();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 24;
  const loadingRef = useRef(false);

  const load = async (reset = false) => {
    if (loadingRef.current) return;
    const p = reset ? 1 : page;
    try {
      loadingRef.current = true;
      setLoading(true);
      const params = {
        type: type || 'all',
        search: searchQuery,
        limit: pageSize,
        offset: (p - 1) * pageSize,
        sort: 'created_at',
        order: 'desc'
      };
      const res = await getMedia(params);
      setItems(reset ? res.items : [...items, ...res.items]);
      setTotal(res.total);
      if (reset) setPage(1);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  };

  useEffect(() => {
    setItems([]);
    setPage(1);
    load(true);
    // eslint-disable-next-line
  }, [type, searchQuery]);

  const titleMap = {
    movie: '电影',
    tvshow: '剧集'
  };
  const pageTitle = searchQuery
    ? `搜索：${searchQuery}`
    : titleMap[type] || '全部媒体';

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <h2 className="section-title">
        <span>{pageTitle} <span style={{ color: 'var(--text-muted)', fontSize: 14, fontWeight: 400 }}>({total})</span></span>
      </h2>

      {error && <div className="error">加载失败：{error}</div>}

      {items.length === 0 && !loading && !error && (
        <div className="empty">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
          </svg>
          <div style={{ fontSize: 16, marginBottom: 12 }}>暂无媒体文件</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            请在服务端配置 <code style={{ background: 'var(--bg-elev)', padding: '2px 6px', borderRadius: 4 }}>MEDIA_DIRS</code> 并执行扫描
          </div>
        </div>
      )}

      <div className="grid">
        {items.map(item => (
          <MediaCard key={item.id} item={item} onClick={() => navigate(`/play/${item.id}`)} />
        ))}
      </div>

      {loading && <div className="loading"><div className="spinner"></div>加载中...</div>}

      {items.length > 0 && totalPages > page && !loading && (
        <div className="pagination">
          <button className="btn secondary" onClick={() => { setPage(p => p + 1); load(false); }} disabled={loading}>
            加载更多
          </button>
          <span className="page-info">{page} / {totalPages} 页</span>
        </div>
      )}
    </div>
  );
}

function MediaCard({ item, onClick }) {
  const typeLabel = { movie: '电影', tvshow: '剧集', other: '视频' }[item.type] || '视频';
  return (
    <div className="card" onClick={onClick}>
      <div className="card-thumb">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <div className="card-type-badge">{typeLabel}</div>
        <div className="card-play-badge"><div className="circle"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div></div>
      </div>
      <div className="card-body">
        <h3 className="card-title">{item.title}</h3>
        <div className="card-meta">
          <span>{formatSize(item.file_size)}</span>
          <span>▶ {item.play_count || 0}</span>
        </div>
      </div>
    </div>
  );
}
