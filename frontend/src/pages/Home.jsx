import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getStats, triggerScan, formatSize, formatDate } from '../api.js';

export default function Home() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState('');
  const navigate = useNavigate();

  const load = async () => {
    try {
      setLoading(true);
      const s = await getStats();
      setStats(s);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onScan = async () => {
    try {
      setScanning(true);
      const r = await triggerScan();
      setToast(`扫描完成：新增/更新 ${r.total} 个，移除 ${r.removed} 个`);
      load();
    } catch (e) {
      setToast('扫描失败：' + e.message);
    } finally {
      setScanning(false);
      setTimeout(() => setToast(''), 3000);
    }
  };

  const typeMap = { movie: '电影', tvshow: '剧集', other: '其他' };

  if (loading) return <div className="loading"><div className="spinner"></div>加载中...</div>;
  if (error) return <div className="error">加载失败：{error}<br/><button className="btn" style={{ marginTop: 12 }} onClick={load}>重试</button></div>;

  const byTypeObj = {};
  for (const t of stats.byType) byTypeObj[t.type] = t.c;

  return (
    <div>
      <section className="hero">
        <h1>欢迎使用 MikTV 家庭媒体中心</h1>
        <p>一站式管理和播放你的本地电影、剧集和视频资源</p>
        <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => navigate('/library')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
            浏览媒体库
          </button>
          <button className="btn secondary" onClick={onScan} disabled={scanning}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>
            </svg>
            {scanning ? '扫描中...' : '扫描媒体库'}
          </button>
        </div>
      </section>

      <section className="stats">
        <div className="stat-card">
          <div className="label">媒体总数</div>
          <div className="value">{stats.total.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="label">电影</div>
          <div className="value">{byTypeObj.movie || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">剧集</div>
          <div className="value">{byTypeObj.tvshow || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">总大小</div>
          <div className="value">{formatSize(stats.totalSize)}</div>
        </div>
      </section>

      {stats.lastPlayed?.length > 0 && (
        <section>
          <h2 className="section-title">
            <span>最近播放</span>
            <Link className="btn secondary" to="/library">查看全部</Link>
          </h2>
          <div className="grid">
            {stats.lastPlayed.map(item => (
              <MediaCard key={item.id} item={item} onClick={() => navigate(`/play/${item.id}`)} />
            ))}
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
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
          <span>播放 {item.play_count || 0}</span>
        </div>
      </div>
    </div>
  );
}
