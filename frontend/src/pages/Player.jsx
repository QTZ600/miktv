import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMediaById, getMediaStreamUrl, getSubtitles, getSubtitleUrl, markPlayed, formatSize, formatDate } from '../api.js';

export default function Player() {
  const { id } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef(null);

  const [item, setItem] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentSub, setCurrentSub] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [m, s] = await Promise.all([getMediaById(id), getSubtitles(id).catch(() => ({ subtitles: [] }))]);
        setItem(m);
        setSubtitles(s.subtitles || []);
        // mark as played after 2s
        setTimeout(() => markPlayed(id).catch(() => {}), 2000);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  if (loading) return <div className="loading"><div className="spinner"></div>加载中...</div>;
  if (error) return <div className="error">加载失败：{error}<br/><button className="btn" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>返回</button></div>;
  if (!item) return <div className="empty">未找到媒体</div>;

  const typeLabel = { movie: '电影', tvshow: '剧集', other: '视频' }[item.type] || '视频';

  return (
    <div className="player-page">
      <button className="back-btn" onClick={() => navigate(-1)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        返回
      </button>

      <div className="player-header">
        <div>
          <h1>{item.title}</h1>
          <div className="player-meta">
            <span>{typeLabel}</span>
            <span>{formatSize(item.file_size)}</span>
            <span>添加于 {formatDate(item.created_at)}</span>
            <span>播放 {item.play_count || 0} 次</span>
            {item.last_played_at && <span>上次播放 {formatDate(item.last_played_at)}</span>}
          </div>
        </div>
      </div>

      <div className="video-wrap">
        <video
          ref={videoRef}
          controls
          preload="metadata"
          playsInline
          src={getMediaStreamUrl(id)}
          crossOrigin="anonymous"
        >
          {subtitles.map(s => (
            <track
              key={s.name}
              kind="subtitles"
              label={s.name}
              src={getSubtitleUrl(id, s.name)}
              srcLang={s.lang || 'zh'}
              default={currentSub === s.name}
            />
          ))}
          您的浏览器不支持 HTML5 视频播放。
        </video>
      </div>

      <div className="info-grid">
        <div className="info-card">
          <h3>文件信息</h3>
          <div className="info-row"><span className="k">标题</span><span>{item.title}</span></div>
          <div className="info-row"><span className="k">类型</span><span>{typeLabel}</span></div>
          <div className="info-row"><span className="k">文件大小</span><span>{formatSize(item.file_size)}</span></div>
          <div className="info-row"><span className="k">文件路径</span><span style={{ wordBreak: 'break-all', textAlign: 'right', maxWidth: '60%' }}>{item.file_path}</span></div>
          <div className="info-row"><span className="k">所在目录</span><span style={{ wordBreak: 'break-all', textAlign: 'right', maxWidth: '60%' }}>{item.directory}</span></div>
          <div className="info-row"><span className="k">添加时间</span><span>{formatDate(item.created_at)}</span></div>
          <div className="info-row"><span className="k">更新时间</span><span>{formatDate(item.updated_at)}</span></div>
        </div>
        <div className="info-card">
          <h3>字幕</h3>
          {subtitles.length === 0 ? (
            <div className="subs-empty">未找到字幕文件</div>
          ) : (
            <div className="subs-list">
              {subtitles.map(s => (
                <a
                  key={s.name}
                  href={getSubtitleUrl(id, s.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn secondary"
                  style={{ justifyContent: 'flex-start' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M6 8h6M6 12h12M14 16h4"/>
                  </svg>
                  {s.name}
                </a>
              ))}
            </div>
          )}
          <h3 style={{ marginTop: 24 }}>快捷操作</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn secondary" onClick={() => navigate('/library')}>返回媒体库</button>
            <button className="btn secondary" onClick={() => videoRef.current?.requestFullscreen?.()}>全屏播放</button>
          </div>
        </div>
      </div>
    </div>
  );
}
