import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Library from './pages/Library.jsx';
import Player from './pages/Player.jsx';

function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;

  const go = (p) => navigate(p);

  return (
    <header className="header">
      <div className="header-inner">
        <div className="logo" onClick={() => go('/')} style={{ cursor: 'pointer' }}>
          <div className="logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          MikTV
        </div>
        <nav className="nav">
          <button className={`nav-btn ${path === '/' ? 'active' : ''}`} onClick={() => go('/')}>首页</button>
          <button className={`nav-btn ${path.startsWith('/library') ? 'active' : ''}`} onClick={() => go('/library')}>媒体库</button>
          <button className={`nav-btn ${path === '/library/movie' ? 'active' : ''}`} onClick={() => go('/library/movie')}>电影</button>
          <button className={`nav-btn ${path === '/library/tvshow' ? 'active' : ''}`} onClick={() => go('/library/tvshow')}>剧集</button>
        </nav>
        <div className="header-right">
          <div className="search-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8, color: 'var(--text-muted)' }}>
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              placeholder="搜索..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target.value.trim()) {
                  go(`/library?search=${encodeURIComponent(e.target.value.trim())}`);
                }
              }}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/library" element={<Library />} />
          <Route path="/library/:type" element={<Library />} />
          <Route path="/play/:id" element={<Player />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <footer className="footer">
        MikTV · 家庭媒体中心 · v0.1.0
      </footer>
    </div>
  );
}
