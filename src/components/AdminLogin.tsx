import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Coffee, Eye, EyeOff, LockKeyhole } from 'lucide-react';

interface AdminLoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onPreview?: () => void;
  onBack: () => void;
}

export function AdminLogin({ onLogin, onPreview, onBack }: AdminLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await onLogin(email.trim(), password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not sign you in. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="admin-login-page">
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Back to reservations
      </button>

      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="login-brand-mark"><Coffee size={24} strokeWidth={1.8} /></div>
        <p className="eyebrow">THE CORNER CAFE · STAFF</p>
        <h1 id="admin-login-title">Welcome back</h1>
        <p className="login-intro">Sign in to manage guest requests and seating.</p>

        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label htmlFor="admin-email">Work email</label>
          <input
            id="admin-email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@cornercafe.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <div className="password-label-row">
            <label htmlFor="admin-password">Password</label>
            <span>Staff account</span>
          </div>
          <div className="password-input-wrap">
            <LockKeyhole size={17} aria-hidden="true" />
            <input
              id="admin-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              className="password-visibility"
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>

          {error && <p className="login-error" role="alert">{error}</p>}

          <button className="btn btn-primary login-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
            {!isSubmitting && <ArrowRight size={17} />}
          </button>
        </form>

        {onPreview && <>
          <div className="login-divider"><span>or</span></div>
          <button type="button" className="preview-button" onClick={onPreview}>Preview staff dashboard</button>
          <p className="login-footnote">Preview uses sample bookings for this session.</p>
        </>}
      </section>

      <p className="login-security-note">Your staff account is managed by the cafe.</p>
    </div>
  );
}
