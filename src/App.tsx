import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AdminLogin } from './components/AdminLogin';
import { AdminPanel } from './components/AdminPanel';
import { BookingWizard } from './components/BookingWizard';
import { CafeHome } from './components/CafeHome';
import { INITIAL_BOOKINGS, INITIAL_TABLES } from './data/cafeData';
import type { Booking, CafeTable } from './types';
import { apiFetch, apiJson, setCsrfToken } from './lib/api';
import './App.css';

type AdminSession = { id?: string; name?: string; email: string; role?: 'owner' | 'staff'; preview: boolean };

function MainApp() {
  const [tables, setTables] = useState<CafeTable[]>(INITIAL_TABLES);
  const [bookings, setBookings] = useState<Booking[]>(INITIAL_BOOKINGS);
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const reservationParams = new URLSearchParams(location.search);
  const initialPartySize = Number(reservationParams.get('partySize'));

  useEffect(() => {
    let active = true;

    const restoreSession = async () => {
      try {
        const response = await apiFetch('/api/admin/auth?action=session');
        if (!response.ok) return;
        const result = await apiJson<{ admin?: AdminSession; csrfToken?: string }>(response);
        if (typeof result.csrfToken === 'string') setCsrfToken(result.csrfToken);
        const admin = result?.admin;
        if (active && typeof admin?.email === 'string') setAdminSession({ ...admin, preview: false });
      } catch {
        // The frontend can still be explored when the identity service is not connected.
      } finally {
        if (active) setAuthLoading(false);
      }
    };

    void restoreSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!adminSession || adminSession.preview) return;
    let active = true;
    setBookings([]);
    const loadDashboard = async () => {
      try {
        const [reservationResponse, tableResponse] = await Promise.all([
          apiFetch('/api/admin/reservations'),
          apiFetch('/api/admin/tables'),
        ]);
        if (!reservationResponse.ok || !tableResponse.ok) throw new Error('Could not load the shared cafe dashboard. Please refresh.');
        const reservationData = await apiJson<{ bookings: Booking[] }>(reservationResponse);
        const tableData = await apiJson<{ tables: CafeTable[] }>(tableResponse);
        if (active) {
          setBookings(reservationData.bookings ?? []);
          setTables(tableData.tables ?? []);
          setDashboardError(null);
        }
      } catch (error) {
        if (active) setDashboardError(error instanceof Error ? error.message : 'Could not load cafe data.');
      }
    };
    void loadDashboard();
    const refreshTimer = window.setInterval(() => { void loadDashboard(); }, 30_000);
    return () => { active = false; window.clearInterval(refreshTimer); };
  }, [adminSession?.email, adminSession?.preview]);

  const handleBookingComplete = async (booking: Booking, idempotencyKey: string, formToken: string, website: string): Promise<Booking> => {
    const response = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          date: booking.date, timeSlot: booking.timeSlot, partySize: booking.partySize,
          tableId: booking.table.id, customerName: booking.customerName,
          customerPhone: booking.customerPhone, customerEmail: booking.customerEmail,
          specialRequests: booking.specialRequests,
          preOrders: booking.preOrders.map(({ item, quantity }) => ({ menuItemId: item.id, quantity })),
          website, formToken,
        }),
      });
    const result = await apiJson<{ booking: Partial<Booking> & { table: Partial<CafeTable> } }>(response);
    return { ...booking, ...result.booking, table: { ...booking.table, ...result.booking.table } as CafeTable };
  };

  const handleUpdateBookingStatus = async (
    bookingId: string,
    newStatus: 'confirmed' | 'pending' | 'cancelled'
  ): Promise<void> => {
    if (adminSession && !adminSession.preview) {
      const response = await apiFetch(`/api/admin/reservation?id=${encodeURIComponent(bookingId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      try {
        const result = await apiJson<{ booking: Booking }>(response);
        setBookings((previous) => previous.map((booking) => booking.id === bookingId ? result.booking : booking));
        setDashboardError(null);
      } catch (error) {
        setDashboardError(error instanceof Error ? error.message : 'Could not update this reservation.');
        return;
      }
      return;
    }
    const target = bookings.find((booking) => booking.id === bookingId);
    setBookings((previous) => previous.map((booking) =>
      booking.id === bookingId ? { ...booking, status: newStatus } : booking
    ));

    if (newStatus === 'cancelled' && target) {
      setTables((previous) => previous.map((table) =>
        table.id === target.table.id ? { ...table, isAvailable: true } : table
      ));
    }
  };

  const handleAdminLogin = async (email: string, password: string) => {
    let response: Response;
    try {
      response = await apiFetch('/api/admin/auth?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new Error('The sign-in service could not be reached. Please try again later.');
    }

    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      throw new Error('Those email and password details were not recognised.');
    }
    if (response.status === 429) {
      throw new Error(result?.error?.message ?? 'Too many sign-in attempts. Wait a little and try again.');
    }
    if (!response.ok) throw new Error(result?.error?.message ?? 'The sign-in service could not complete the request. Please try again.');
    if (typeof result.csrfToken === 'string') setCsrfToken(result.csrfToken);
    const admin = result?.admin ?? { email };
    setAdminSession({ ...admin, email: admin.email ?? email, preview: false });
    navigate('/admin');
  };

  const handlePreviewLogin = () => {
    const previewEmail = 'preview@cornercafe.test';
    setAdminSession({ email: previewEmail, role: 'staff', preview: true });
    navigate('/admin');
  };

  const handleSignOut = async () => {
    if (adminSession?.preview) {
        setCsrfToken(null);
    } else if (adminSession) {
      try {
        await apiFetch('/api/admin/auth/logout', { method: 'POST' });
      } catch {
        // Clear the local view even if the service is temporarily unavailable.
      }
    }
    setCsrfToken(null);
    setAdminSession(null);
    navigate('/');
  };

  return (
    <div className="app-shell">
      <main className="app-main">
        <Routes>
          <Route
            path="/"
            element={<CafeHome onBook={(intent) => {
              const params = new URLSearchParams({
                date: intent.date,
                time: intent.time,
                partySize: String(intent.partySize),
              });
              navigate(`/reserve?${params.toString()}`);
            }} />}
          />
          <Route
            path="/reserve"
            element={(
              <BookingWizard
                tables={tables}
                onBookingComplete={handleBookingComplete}
                onGoToAdmin={() => navigate('/admin/login')}
                onGoHome={() => navigate('/')}
                initialDate={reservationParams.get('date') ?? undefined}
                initialTime={reservationParams.get('time') ?? undefined}
                initialPartySize={initialPartySize || undefined}
              />
            )}
          />
          <Route
            path="/admin/login"
            element={authLoading
              ? <div className="auth-loading" role="status">Checking staff access…</div>
              : adminSession
                ? <Navigate to="/admin" replace />
              : <AdminLogin onLogin={handleAdminLogin} onPreview={import.meta.env.DEV ? handlePreviewLogin : undefined} onBack={() => navigate('/')} />}
          />
          <Route
            path="/admin"
            element={authLoading
              ? <div className="auth-loading" role="status">Checking staff access…</div>
              : adminSession
                ? (
                  <>
                    {adminSession.preview && (
                      <div className="preview-banner" role="status">
                        Sample data preview <span>·</span> Changes last for this session only
                      </div>
                    )}
                    <AdminPanel
                      bookings={bookings}
                      tables={tables}
                      adminEmail={adminSession.email}
                      adminRole={adminSession.role ?? 'staff'}
                      dataError={dashboardError}
                      onUpdateBookingStatus={handleUpdateBookingStatus}
                      onRefresh={async () => {
                        if (adminSession.preview) return;
                        const [reservationResponse, tableResponse] = await Promise.all([
                          apiFetch('/api/admin/reservations'),
                          apiFetch('/api/admin/tables'),
                        ]);
                        if (!reservationResponse.ok || !tableResponse.ok) throw new Error('Could not refresh the cafe dashboard.');
                        const [reservationData, tableData] = await Promise.all([
                          apiJson<{ bookings: Booking[] }>(reservationResponse),
                          apiJson<{ tables: CafeTable[] }>(tableResponse),
                        ]);
                        setBookings(reservationData.bookings ?? []);
                        setTables(tableData.tables ?? []);
                      }}
                      onGoToCustomerView={handleSignOut}
                    />
                  </>
                )
                : <Navigate to="/admin/login" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {location.pathname !== '/' && (
        <footer className="app-footer">
          <span className="footer-brand">THE CORNER CAFE</span>
          <span>Reservations made simple</span>
          <span>© {new Date().getFullYear()} The Corner Cafe</span>
        </footer>
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <MainApp />
    </BrowserRouter>
  );
}
