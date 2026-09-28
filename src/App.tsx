import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import {
  Download,
  Film,
  CreditCard,
  Image as ImageIcon,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';

type Mode = 'text' | 'image';
type View = 'home' | 'create' | 'creations' | 'balance' | 'fund' | 'usage' | 'plans';
type HistoryItem = {
  id: string;
  prompt: string;
  mode: Mode;
  aspectRatio: string;
  resolution: string;
  videoUrl: string;
  createdAt: string;
};

const HISTORY_KEY = 'cineforge-history-v1';

function App() {
  const [mode, setMode] = useState<Mode>('text');
  const [prompt, setPrompt] = useState('');
  const [imageData, setImageData] = useState('');
  const [imageName, setImageName] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('480p');
  const [duration, setDuration] = useState('5');
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [billingOpen, setBillingOpen] = useState(false);
  const [view, setView] = useState<View>('home');
  const [billingEmail, setBillingEmail] = useState(() => localStorage.getItem('cineforge-billing-email') || '');
  const [selectedAmount, setSelectedAmount] = useState(5000);
  const [balanceNaira, setBalanceNaira] = useState(0);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(HISTORY_KEY) || '[]'
      ) as HistoryItem[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (billingEmail) localStorage.setItem('cineforge-billing-email', billingEmail);
    const reference = new URLSearchParams(window.location.search).get('reference');
    if (reference && billingEmail) {
      api.get(`/api/paystack/verify?reference=${encodeURIComponent(reference)}&email=${encodeURIComponent(billingEmail)}`)
        .then(response => {
          const result = response.data as { ok?: boolean; status?: string; balanceNaira?: number; creditedNaira?: number; error?: string };
          if (result.ok && result.status === 'success') {
            setBalanceNaira(Number(result.balanceNaira || 0));
            setStatus(result.creditedNaira ? `Payment confirmed. ₦${Number(result.creditedNaira).toLocaleString()} added.` : 'Payment confirmed.');
            setView('balance');
          } else if (result.error) {
            setErrorMessage(result.error);
          }
        })
        .catch(() => setErrorMessage('We could not verify the returned Paystack payment yet.'))
        .finally(() => window.history.replaceState({}, document.title, window.location.pathname));
    }
  }, [billingEmail]);

  useEffect(() => {
    if (!billingEmail) return;
    api.get(`/api/balance?email=${encodeURIComponent(billingEmail)}`)
      .then(response => setBalanceNaira(Number((response.data as { balanceNaira?: number }).balanceNaira || 0)))
      .catch(() => undefined);
  }, [billingEmail]);

  const frames = useMemo(() => {
    const seconds = Number(duration);
    return Math.max(25, Math.min(121, Math.round(seconds * 24)));
  }, [duration]);

  const handleImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErrorMessage('Please use an image smaller than 8 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageData(String(reader.result || ''));
      setImageName(file.name);
      setErrorMessage('');
      setMode('image');
    };
    reader.readAsDataURL(file);
  };

  const generate = async () => {
    setErrorMessage('');
    setVideoUrl('');
    if (!prompt.trim()) {
      setErrorMessage('Describe the video you want to create.');
      return;
    }
    if (mode === 'image' && !imageData) {
      setErrorMessage('Upload an image for image-to-video generation.');
      return;
    }

    setGenerating(true);
    setStatus('Preparing your generation…');

    try {
      setStatus('Generating with free Hugging Face ZeroGPU…');
      const response = await api.post('/api/generate-video', {
        prompt: prompt.trim(),
        image: mode === 'image' ? imageData : null,
        aspectRatio,
        resolution,
        numFrames: frames,
      });
      const result = response.data as {
        status?: string;
        predictionId?: string;
        id?: string;
        videoUrl?: string;
        error?: string;
      };
      let readyUrl = result.videoUrl || '';
      const jobId = result.predictionId || result.id;
      if (!readyUrl && jobId) {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const poll = await api.get(
            `/api/generate-video/${encodeURIComponent(jobId)}`
          );
          const current = poll.data as {
            status?: string;
            videoUrl?: string;
            error?: string;
          };
          if ((current.status === 'completed' || current.status === 'succeeded') && current.videoUrl) {
            readyUrl = current.videoUrl;
            break;
          }
          if (current.status === 'failed' || current.status === 'canceled') {
            throw new Error(current.error || `Generation ${current.status}.`);
          }
          setStatus(
            `Generating with free Hugging Face ZeroGPU… ${Math.min(
              99,
              Math.round(((attempt + 1) / 200) * 100)
            )}%`
          );
        }
      }
      if (!readyUrl) {
        throw new Error(
          result.error ||
            'Video generation is still processing. The provider did not finish within 10 minutes.'
        );
      }
      setVideoUrl(readyUrl);
      setStatus('Video ready.');
      const item: HistoryItem = {
        id: crypto.randomUUID(),
        prompt: prompt.trim(),
        mode,
        aspectRatio,
        resolution,
        videoUrl: readyUrl,
        createdAt: new Date().toISOString(),
      };
      setHistory(items => [item, ...items].slice(0, 20));
    } catch (error) {
      setStatus('');
      const responseError = (error as { response?: { data?: { error?: string } }; data?: { error?: string } })?.response?.data?.error || (error as { data?: { error?: string } })?.data?.error;
      const message = responseError || (error instanceof Error ? error.message : 'Video generation failed. Please try again.');
      setErrorMessage(message.replace(/^Request failed with status code \d+$/i, 'The free video provider rejected the request. Please try again in a few minutes or check your Hugging Face quota.'));
    } finally {
      setGenerating(false);
    }
  };

  const startPayment = async () => {
    setErrorMessage('');
    setStatus('');
    if (!billingEmail.trim() || !billingEmail.includes('@')) {
      setErrorMessage('Enter the email address you use for Paystack checkout.');
      return;
    }
    setPaymentBusy(true);
    try {
      const response = await api.post('/api/paystack/initialize', { email: billingEmail.trim(), amountNaira: selectedAmount });
      const result = response.data as { ok?: boolean; authorizationUrl?: string; error?: string };
      if (!result.ok || !result.authorizationUrl) throw new Error(result.error || 'Paystack could not start the checkout.');
      window.location.href = result.authorizationUrl;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Paystack checkout could not be started.');
    } finally {
      setPaymentBusy(false);
    }
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  };

  return (
    <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <button className="sidebar-brand" onClick={() => setView('home')} aria-label="CineForge AI home">
          <div className="brand-mark"><Film size={19} /></div>
          {sidebarOpen && <div><strong>CineForge AI</strong><span>Video studio</span></div>}
        </button>
        <button className="sidebar-toggle" onClick={() => setSidebarOpen(value => !value)} aria-label="Toggle sidebar">
          {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <nav className="sidebar-nav">
          <button className={`nav-item ${view === 'create' ? 'active' : ''}`} onClick={() => setView('create')}><Sparkles size={17} />{sidebarOpen && 'Create'}</button>
          <button className={`nav-item ${view === 'creations' ? 'active' : ''}`} onClick={() => setView('creations')}><Film size={17} />{sidebarOpen && 'My Creations'}</button>
          <button className="nav-item"><ImageIcon size={17} />{sidebarOpen && 'Assets'}</button>
          <button className="nav-item" onClick={() => setBillingOpen(true)}><CreditCard size={17} />{sidebarOpen && 'Billing & Usage'}</button>
          <button className="nav-item"><Settings size={17} />{sidebarOpen && 'Settings'}</button>
        </nav>
        {sidebarOpen && (
          <div className="sidebar-bottom">
            <div className="usage-card">
              <div className="usage-row"><span>Free usage</span><strong>5 min/day</strong></div>
              <div className="usage-track"><span /></div>
              <small>Upgrade for more generation capacity.</small>
            </div>
            <button className="upgrade-button" onClick={() => setBillingOpen(true)}>
              <Sparkles size={16} /> Upgrade plan
            </button>
          </div>
        )}
      </aside>
      <div className="main-content">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Film size={21} />
          </div>
          <div>
            <strong>CineForge AI</strong>
            <span>AI cinematic video studio</span>
          </div>
        </div>
        <div className="topbar-badge">
          <Menu size={15} /> Free · 5 min/day
        </div>
      </header>

      {view === 'home' && <section className="home-hero">
        <div className="eyebrow"><WandSparkles size={16} /> CINEFORGE AI</div>
        <h1>Bring your ideas<br /><span>to cinematic life.</span></h1>
        <p>Create cinematic AI videos from a simple description or a reference image. Direct your scene, shape the motion, and turn imagination into moving pictures.</p>
        <button className="home-cta" onClick={() => setView('create')}><WandSparkles size={18} /> Start creating</button>
        <div className="home-points">
          <button className="home-card" onClick={() => setView('balance')}><CreditCard size={21} /><span>Account balance</span><strong>₦{balanceNaira.toLocaleString()}</strong><small>View balance & transactions</small></button>
          <button className="home-card" onClick={() => setView('fund')}><CreditCard size={21} /><span>Fund account</span><strong>Add funds</strong><small>Manage your CineForge credits</small></button>
          <button className="home-card" onClick={() => setView('usage')}><Sparkles size={21} /><span>Usage & credits</span><strong>5 min/day</strong><small>Track your generation allowance</small></button>
          <button className="home-card" onClick={() => setView('plans')}><WandSparkles size={21} /><span>Plans & pricing</span><strong>Free · Pro</strong><small>Compare available plans</small></button>
        </div>
      </section>}

      {view === 'balance' && <section className="account-page"><button className="back-link" onClick={() => setView('home')}>← Back to home</button><div className="eyebrow"><CreditCard size={16} /> ACCOUNT BALANCE</div><h1>Balance</h1><div className="balance-large">₦{balanceNaira.toLocaleString()}</div><p>Your CineForge account balance is stored securely on the backend. Use Fund account to add money through Paystack.</p>{status && <div className="success-box">{status}</div>}<button className="home-cta" onClick={() => setView('fund')}>Fund account</button></section>}
      {view === 'fund' && <section className="account-page"><button className="back-link" onClick={() => setView('home')}>← Back to home</button><div className="eyebrow"><CreditCard size={16} /> FUND ACCOUNT</div><h1>Add funds to CineForge</h1><p>Pay securely through Paystack. This build is connected to Paystack test mode, so no real money is charged.</p><label className="field-label">PAYMENT EMAIL</label><input className="billing-input" type="email" value={billingEmail} onChange={event => setBillingEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /><div className="fund-options"><button className={selectedAmount === 1000 ? 'selected' : ''} onClick={() => setSelectedAmount(1000)}>₦1,000</button><button className={selectedAmount === 5000 ? 'selected' : ''} onClick={() => setSelectedAmount(5000)}>₦5,000</button><button className={selectedAmount === 10000 ? 'selected' : ''} onClick={() => setSelectedAmount(10000)}>₦10,000</button><button className={selectedAmount === 20000 ? 'selected' : ''} onClick={() => setSelectedAmount(20000)}>₦20,000</button></div><button className="home-cta" onClick={startPayment} disabled={paymentBusy}>{paymentBusy ? <><Loader2 className="spin" size={18} /> Opening Paystack…</> : <>Continue to Paystack</>}</button>{errorMessage && <div className="error-box">{errorMessage}</div>}</section>}
      {view === 'usage' && <section className="account-page"><button className="back-link" onClick={() => setView('home')}>← Back to home</button><div className="eyebrow"><Sparkles size={16} /> USAGE & CREDITS</div><h1>Your usage</h1><div className="usage-large"><strong>5 min/day</strong><span>Free ZeroGPU allowance</span><div className="usage-track"><span /></div></div><p>Monitor your daily generation allowance here. Paid capacity will be shown when a paid provider plan is connected.</p></section>}
      {view === 'plans' && <section className="account-page"><button className="back-link" onClick={() => setView('home')}>← Back to home</button><div className="eyebrow"><WandSparkles size={16} /> PLANS & PRICING</div><h1>Choose your plan</h1><div className="home-plan-grid"><div><span>FREE</span><h2>Free</h2><strong>5 min/day</strong><p>Access the current free ZeroGPU generation allowance.</p></div><div><span>PRO</span><h2>Pro</h2><strong>More capacity</strong><p>Paid capacity will be activated after payment and provider integration are completed.</p></div></div></section>}

      {view === 'create' && <section className="hero">
        <div className="eyebrow">
          <WandSparkles size={16} /> CREATE CINEMATIC VIDEO
        </div>
        <h1>
          Turn a scene into <span>cinematic motion.</span>
        </h1>
        <p>
          Describe the shot you want, or animate an image with AI. CineForge AI
          turns your direction into a downloadable video.
        </p>
      </section>}

      {view === 'create' && <section className="workspace">
        <div className="panel composer">
          <div className="mode-tabs">
            <button
              className={mode === 'text' ? 'active' : ''}
              onClick={() => setMode('text')}
            >
              <Sparkles size={17} /> Text to Video
            </button>
            <button
              className={mode === 'image' ? 'active' : ''}
              onClick={() => setMode('image')}
            >
              <ImageIcon size={17} /> Image to Video
            </button>
          </div>

          <label className="field-label">SCENE DESCRIPTION</label>
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="A cinematic close-up of a young woman walking through a rain-soaked Tokyo street at night, neon reflections, shallow depth of field, slow camera push-in…"
            rows={7}
          />

          {mode === 'image' && (
            <div className="upload-box">
              <input ref={imageInputRef} className="upload-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImage} />
              <Upload size={22} />
              <strong>{imageName || 'Upload a reference image'}</strong>
              <span>PNG, JPG or WEBP · max 8 MB</span>
              <button type="button" className="upload-button" onClick={() => imageInputRef.current?.click()}>
                {imageName ? 'Choose another image' : 'Choose image'}
              </button>
              {imageData && <img className="upload-preview" src={imageData} alt="Selected reference" />}
            </div>
          )}

          <div className="controls-grid">
            <label>
              <span>Aspect ratio</span>
              <select
                value={aspectRatio}
                onChange={event => setAspectRatio(event.target.value)}
              >
                <option>16:9</option>
                <option>9:16</option>
              </select>
            </label>
            <label>
              <span>Quality</span>
              <select
                value={resolution}
                onChange={event => setResolution(event.target.value)}
              >
                <option>480p</option>
                <option>720p</option>
              </select>
            </label>
            <label>
              <span>Duration</span>
              <select
                value={duration}
                onChange={event => setDuration(event.target.value)}
              >
                <option value="2">2 seconds</option>
                <option value="3">3 seconds</option>
                <option value="4">4 seconds</option>
                <option value="5">5 seconds</option>
              </select>
            </label>
          </div>

          <button
            className="generate-button"
            onClick={generate}
            disabled={generating}
          >
            {generating ? (
              <>
                <Loader2 className="spin" size={19} /> Generating…
              </>
            ) : (
              <>
                <WandSparkles size={19} /> Generate video
              </>
            )}
          </button>

          {generating && (
            <div className="progress">
              <div className="progress-bar" />
              <span>{status}</span>
            </div>
          )}
          {errorMessage && <div className="error-box">{errorMessage}</div>}
        </div>

        <div className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <span>OUTPUT</span>
              <h2>Preview</h2>
            </div>
            {videoUrl && (
              <a
                className="download-link"
                href={videoUrl}
                target="_blank"
                rel="noreferrer"
                download
              >
                <Download size={16} /> Download
              </a>
            )}
          </div>
          <div
            className={`preview ${aspectRatio === '9:16' ? 'portrait' : aspectRatio === '1:1' ? 'square' : ''}`}
          >
            {videoUrl ? (
              <video src={videoUrl} controls playsInline />
            ) : (
              <div className="empty-preview">
                <div className="empty-icon">
                  <Film size={28} />
                </div>
                <strong>Your generated video appears here</strong>
                <span>Enter a scene and generate your first clip.</span>
              </div>
            )}
          </div>
          {status && !generating && (
            <div className="ready-line">
              <span />
              {status}
            </div>
          )}
        </div>
      </section>}

      {view === 'creations' && <section className="history-section" id="history">
        <div className="section-heading">
          <div>
            <span>YOUR CREATIONS</span>
            <h2>Recent generations</h2>
          </div>
          {history.length > 0 && (
            <button className="clear-button" onClick={clearHistory}>
              <Trash2 size={15} /> Clear history
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="history-empty">
            Your completed generations will be kept here on this device.
          </div>
        ) : (
          <div className="history-grid">
            {history.map(item => (
              <article className="history-card" key={item.id}>
                <video src={item.videoUrl} muted playsInline />
                <div className="history-card-body">
                  <span>
                    {item.mode === 'image' ? 'IMAGE TO VIDEO' : 'TEXT TO VIDEO'}{' '}
                    · {item.aspectRatio}
                  </span>
                  <p>{item.prompt}</p>
                  <a
                    href={item.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    download
                  >
                    <Download size={14} /> Download
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>}

      <footer>CineForge AI · Free Hugging Face ZeroGPU · LTX-2.5</footer>
      </div>
      {billingOpen && (
        <div className="modal-backdrop" onClick={() => setBillingOpen(false)}>
          <div className="billing-modal" onClick={event => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setBillingOpen(false)} aria-label="Close billing"><X size={18} /></button>
            <span className="modal-eyebrow">CINEFORGE BILLING</span>
            <h2>Upgrade your video studio</h2>
            <p>Manage your usage, payment method and plan from one place.</p>
            <div className="plan-grid">
              <div className="plan-card current">
                <span>Current plan</span><h3>Free</h3><strong>5 min/day</strong><small>Hugging Face ZeroGPU</small>
              </div>
              <div className="plan-card featured">
                <span>For creators</span><h3>Pro</h3><strong>More generation capacity</strong><small>Payment provider connection required to activate paid billing.</small>
                <button onClick={() => { setBillingOpen(false); setErrorMessage(''); setStatus('Pro billing selected. Choose an amount and continue to Paystack test checkout.'); setView('fund'); }}>Upgrade to Pro</button>
              </div>
            </div>
            <div className="payment-row">
              <div><CreditCard size={18} /><div><strong>Payment method</strong><small>No payment method connected</small></div></div>
              <button className="secondary-button" onClick={() => setErrorMessage('Payment method setup is ready in the UI, but card collection requires a payment processor such as Stripe to be connected.')}>Add payment method</button>
            </div>
            <div className="billing-note">No card is required for the Free plan. Your current generation provider remains free within its daily quota.</div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
