import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Coffee,
  Minus,
  Plus,
  UserRound,
  Users,
} from 'lucide-react';
import { MENU_ITEMS, TIME_SLOTS } from '../data/cafeData';
import { apiFetch, apiJson } from '../lib/api';
import type { Booking, CafeTable, MenuItem, PreOrderItem, WizardState } from '../types';
import { SeatCube } from './SeatCube';
import './booking-flow.css';

interface BookingWizardProps {
  tables: CafeTable[];
  onBookingComplete: (newBooking: Booking, idempotencyKey: string, formToken: string, website: string) => Promise<Booking>;
  onGoToAdmin: () => void;
  onGoHome: () => void;
  initialDate?: string;
  initialTime?: string;
  initialPartySize?: number;
}

const steps = [
  { number: 1, label: 'Choose table', Icon: Users },
  { number: 2, label: 'Pick a time', Icon: Clock3 },
  { number: 3, label: 'Add a treat', Icon: Coffee },
  { number: 4, label: 'Your details', Icon: UserRound },
  { number: 5, label: 'Review', Icon: Check },
];

function todayAsDateInput() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function displayDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function createStartingState(initialDate?: string, initialTime?: string, initialPartySize?: number): WizardState {
  const today = todayAsDateInput();
  const date = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) && initialDate >= today ? initialDate : today;
  const partySize = Number.isInteger(initialPartySize) && initialPartySize! >= 1 && initialPartySize! <= 8 ? initialPartySize! : 2;
  const timeSlot = initialTime && TIME_SLOTS.includes(initialTime) ? initialTime : '10:30 AM';
  return {
    date,
    partySize,
    selectedTable: null,
    timeSlot,
    preOrders: [],
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    specialRequests: '',
  };
}

export function BookingWizard({
  tables,
  onBookingComplete,
  onGoToAdmin,
  onGoHome,
  initialDate,
  initialTime,
  initialPartySize,
}: BookingWizardProps) {
  const [formData, setFormData] = useState<WizardState>(() => createStartingState(initialDate, initialTime, initialPartySize));
  const [currentStep, setCurrentStep] = useState(1);
  const [availableTables, setAvailableTables] = useState<CafeTable[]>(tables);
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completedBooking, setCompletedBooking] = useState<Booking | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [website, setWebsite] = useState('');
  const formToken = useRef('');
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const today = todayAsDateInput();
  const preOrderTotal = formData.preOrders.reduce((sum, entry) => sum + entry.item.price * entry.quantity, 0);
  const categories = ['All', ...Array.from(new Set(MENU_ITEMS.map((item) => item.category)))];
  const visibleMenuItems = MENU_ITEMS.filter((item) => selectedCategory === 'All' || item.category === selectedCategory);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    let active = true;
    setAvailabilityLoading(true);
    apiFetch(`/api/availability?date=${encodeURIComponent(formData.date)}&partySize=${formData.partySize}`)
      .then((response) => apiJson<{ tables: CafeTable[]; formToken: string }>(response))
      .then((result) => {
        if (active) {
          setAvailableTables(result.tables ?? []);
          formToken.current = result.formToken || formToken.current;
          setAvailabilityError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) setAvailabilityError(error instanceof Error ? error.message : 'Could not load live seating availability.');
      })
      .finally(() => { if (active) setAvailabilityLoading(false); });
    return () => { active = false; };
  }, [formData.date, formData.partySize]);

  useEffect(() => {
    const table = formData.selectedTable;
    if (!table) {
      setAvailableSlots([]);
      return;
    }
    let active = true;
    setAvailableSlots([]);
    apiFetch(`/api/availability?date=${encodeURIComponent(formData.date)}&partySize=${formData.partySize}&tableId=${encodeURIComponent(table.id)}`)
      .then((response) => apiJson<{ availableSlots: string[]; formToken: string }>(response))
      .then((result) => {
        if (active) {
          formToken.current = result.formToken || formToken.current;
          const slots: string[] = result.availableSlots ?? [];
          setAvailableSlots(slots);
          setAvailabilityError(null);
          setFormData((previous) => slots.includes(previous.timeSlot) || slots.length === 0
            ? previous
            : { ...previous, timeSlot: slots[0] });
        }
      })
      .catch((error: unknown) => {
        if (active) setAvailabilityError(error instanceof Error ? error.message : 'Could not load available times.');
      });
    return () => { active = false; };
  }, [formData.date, formData.partySize, formData.selectedTable?.id]);

  const changeVisit = (key: 'date' | 'partySize', value: string | number) => {
    setFormData((previous) => ({
      ...previous,
      [key]: value,
      selectedTable: null,
    }));
    setValidationError(null);
  };

  const updateItemQty = (item: MenuItem, delta: number) => {
    setFormData((previous) => {
      const current = previous.preOrders.find((entry) => entry.item.id === item.id)?.quantity ?? 0;
      const quantity = Math.max(0, Math.min(20, current + delta));
      let preOrders: PreOrderItem[];
      if (quantity === 0) preOrders = previous.preOrders.filter((entry) => entry.item.id !== item.id);
      else if (current > 0) preOrders = previous.preOrders.map((entry) => entry.item.id === item.id ? { ...entry, quantity } : entry);
      else preOrders = [...previous.preOrders, { item, quantity }];
      return { ...previous, preOrders };
    });
  };

  const goNext = () => {
    setValidationError(null);
    if (currentStep === 1 && !formData.selectedTable) {
      setValidationError('Choose an available table from one of the three floors to continue.');
      return;
    }
    if (currentStep === 2 && !availableSlots.includes(formData.timeSlot)) {
      setValidationError('Choose an available time for this table.');
      return;
    }
    if (currentStep === 4) {
      if (formData.customerName.trim().length < 2) {
        setValidationError('Please enter your name.');
        return;
      }
      if (!formData.customerPhone.trim() && !formData.customerEmail.trim()) {
        setValidationError('Add a phone number or email so the cafe can confirm your request.');
        return;
      }
    }
    setCurrentStep((step) => Math.min(5, step + 1));
  };

  const goBack = () => {
    setValidationError(null);
    setCurrentStep((step) => Math.max(1, step - 1));
  };

  const submitBooking = async () => {
    if (!formData.selectedTable || !availableSlots.includes(formData.timeSlot)) {
      setValidationError('That table or time is no longer available. Please choose another.');
      setCurrentStep(formData.selectedTable ? 2 : 1);
      return;
    }
    const booking: Booking = {
      id: '',
      referenceNumber: '',
      date: formData.date,
      timeSlot: formData.timeSlot,
      partySize: formData.partySize,
      table: formData.selectedTable,
      preOrders: formData.preOrders,
      customerName: formData.customerName.trim(),
      customerPhone: formData.customerPhone.trim(),
      customerEmail: formData.customerEmail.trim(),
      specialRequests: formData.specialRequests.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const fingerprint = JSON.stringify({
      date: booking.date, timeSlot: booking.timeSlot, partySize: booking.partySize,
      table: booking.table.id, name: booking.customerName, phone: booking.customerPhone,
      email: booking.customerEmail, requests: booking.specialRequests,
      preOrders: booking.preOrders.map(({ item, quantity }) => [item.id, quantity]),
    });
    if (!idempotency.current || idempotency.current.fingerprint !== fingerprint) {
      idempotency.current = { fingerprint, key: crypto.randomUUID() };
    }
    setSubmitting(true);
    setValidationError(null);
    try {
      if (!formToken.current) throw new Error('Reservation verification expired. Please refresh seating and try again.');
      setCompletedBooking(await onBookingComplete(booking, idempotency.current.key, formToken.current, website));
      idempotency.current = null;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'We could not send the reservation. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetBooking = () => {
    setFormData(createStartingState());
    setWebsite('');
    setCurrentStep(1);
    setCompletedBooking(null);
    setValidationError(null);
    formToken.current = '';
    idempotency.current = null;
  };

  if (completedBooking) {
    return (
      <main className="booking-page">
        <header className="booking-topbar">
          <button type="button" className="booking-back-link" onClick={onGoHome}><ArrowLeft size={15} /> Back to cafe</button>
          <a className="booking-brand" href="/" onClick={(event) => { event.preventDefault(); onGoHome(); }}>THE CORNER CAFE</a>
          <button type="button" className="booking-staff-link" onClick={onGoToAdmin}>Staff login</button>
        </header>
        <section className="booking-confirmation" aria-labelledby="booking-confirmation-title">
          <span className="booking-confirmation__icon"><CheckCircle2 size={34} aria-hidden="true" /></span>
          <p className="booking-eyebrow">REQUEST RECEIVED · AWAITING CONFIRMATION</p>
          <h1 id="booking-confirmation-title">Your table request is in.</h1>
          <p className="booking-confirmation__intro">The cafe team will review the request and confirm your reservation.</p>
          <div className="booking-confirmation__reference"><span>Request reference</span><strong>{completedBooking.referenceNumber}</strong></div>
          <div className="booking-confirmation__details">
            <div><span>Visit</span><strong>{displayDate(completedBooking.date)} · {completedBooking.timeSlot}</strong></div>
            <div><span>Table</span><strong>{completedBooking.table.id} · Floor {completedBooking.table.floor} {completedBooking.table.zone}</strong></div>
            <div><span>Party</span><strong>{completedBooking.partySize} {completedBooking.partySize === 1 ? 'guest' : 'guests'}</strong></div>
            <div><span>Name</span><strong>{completedBooking.customerName}</strong></div>
          </div>
          <div className="booking-confirmation__actions">
            <button type="button" className="btn btn-primary" onClick={resetBooking}>Make another reservation</button>
            <button type="button" className="btn btn-amber" onClick={onGoHome}>Back to cafe</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="booking-page">
      <header className="booking-topbar">
        <button type="button" className="booking-back-link" onClick={onGoHome}><ArrowLeft size={15} /> Back to cafe</button>
        <a className="booking-brand" href="/" onClick={(event) => { event.preventDefault(); onGoHome(); }}>THE CORNER CAFE</a>
        <button type="button" className="booking-staff-link" onClick={onGoToAdmin}>Staff login <ArrowRight size={14} /></button>
      </header>

      <section className="booking-intro">
        <p className="booking-eyebrow">SAVE A SEAT AT YOUR CORNER</p>
        <h1>Make a little time for coffee.</h1>
        <p>Choose a table, then send a reservation request to our team.</p>
      </section>

      <section className="booking-shell">
        <div className="booking-visit-bar" aria-label="Your visit details">
          <label className="booking-visit-field" htmlFor="booking-date">
            <span><CalendarDays size={15} /> DATE</span>
            <input id="booking-date" type="date" min={today} value={formData.date} onChange={(event) => changeVisit('date', event.target.value)} />
          </label>
          <label className="booking-visit-field" htmlFor="booking-party">
            <span><Users size={15} /> GUESTS</span>
            <select id="booking-party" value={formData.partySize} onChange={(event) => changeVisit('partySize', Number(event.target.value))}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} {count === 1 ? 'guest' : 'guests'}</option>)}
            </select>
          </label>
          <div className="booking-visit-summary"><span>YOUR VISIT</span><strong>{displayDate(formData.date)} · {formData.partySize} {formData.partySize === 1 ? 'guest' : 'guests'}</strong></div>
        </div>

        <nav className="booking-progress" aria-label="Reservation progress">
          {steps.map(({ number, label, Icon }) => (
            <button
              type="button"
              key={number}
              className={`booking-progress__step${currentStep === number ? ' is-current' : ''}${currentStep > number ? ' is-done' : ''}`}
              aria-current={currentStep === number ? 'step' : undefined}
              onClick={() => { if (number < currentStep) { setCurrentStep(number); setValidationError(null); } }}
              disabled={number >= currentStep}
            >
              <span className="booking-progress__number">{currentStep > number ? <Check size={14} /> : <Icon size={14} />}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="booking-card">
          {(validationError || availabilityError) && <div className="booking-alert" role="alert">{validationError || availabilityError}</div>}

          {currentStep === 1 && (
            <section className="booking-step" aria-labelledby="booking-table-title">
              <div className="booking-step__heading">
                <p className="booking-eyebrow">01 · TABLES BY FLOOR</p>
                <h2 id="booking-table-title">Choose your corner.</h2>
                <p>Rotate the cube to see the tables on each side. Each floor has nine tables.</p>
              </div>
              {availabilityLoading && <p className="booking-live-status" role="status">Checking current availability…</p>}
              <SeatCube
                tables={availableTables}
                selectedTableId={formData.selectedTable?.id ?? null}
                onSelectTable={(table) => { setFormData((previous) => ({ ...previous, selectedTable: table })); setValidationError(null); }}
                partySize={formData.partySize}
              />
              {formData.selectedTable && (
                <div className="booking-selection" aria-live="polite">
                  <span className="booking-selection__icon"><Check size={17} /></span>
                  <div><span>YOUR TABLE</span><strong>{formData.selectedTable.id} · Floor {formData.selectedTable.floor} {formData.selectedTable.zone}</strong></div>
                  <span>{formData.selectedTable.capacity} seats</span>
                </div>
              )}
            </section>
          )}

          {currentStep === 2 && (
            <section className="booking-step" aria-labelledby="booking-time-title">
              <div className="booking-step__heading">
                <p className="booking-eyebrow">02 · ARRIVAL</p>
                <h2 id="booking-time-title">What time works for you?</h2>
                <p>{formData.selectedTable?.id} is on Floor {formData.selectedTable?.floor}, {formData.selectedTable?.zone}. It will be held for 90 minutes.</p>
              </div>
              {availableSlots.length === 0 && !availabilityError && !availabilityLoading && <p className="booking-empty-note">This table has no open time today. Go back and choose another table.</p>}
              <div className="booking-time-grid">
                {TIME_SLOTS.map((slot) => {
                  const isAvailable = availableSlots.includes(slot);
                  return (
                    <button key={slot} type="button" className={`booking-time-option${formData.timeSlot === slot ? ' is-selected' : ''}`} onClick={() => setFormData((previous) => ({ ...previous, timeSlot: slot }))} disabled={!isAvailable} aria-pressed={formData.timeSlot === slot}>
                      <Clock3 size={16} aria-hidden="true" />
                      <span>{slot}</span>
                      <small>{isAvailable ? 'Available' : 'Reserved'}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {currentStep === 3 && (
            <section className="booking-step" aria-labelledby="booking-menu-title">
              <div className="booking-step__heading booking-step__heading--row">
                <div>
                  <p className="booking-eyebrow">03 · A LITTLE SOMETHING EXTRA</p>
                  <h2 id="booking-menu-title">Would you like us to prepare a treat?</h2>
                  <p>Pre-order a few cafe favorites. This step is optional.</p>
                </div>
                <div className="booking-order-total"><span>{formData.preOrders.reduce((sum, entry) => sum + entry.quantity, 0)} items</span><strong>${preOrderTotal.toFixed(2)}</strong></div>
              </div>
              <div className="booking-category-list" aria-label="Filter menu items">
                {categories.map((category) => <button type="button" className={`booking-category${selectedCategory === category ? ' is-active' : ''}`} key={category} onClick={() => setSelectedCategory(category)} aria-pressed={selectedCategory === category}>{category}</button>)}
              </div>
              <div className="booking-menu-grid">
                {visibleMenuItems.map((item) => {
                  const quantity = formData.preOrders.find((entry) => entry.item.id === item.id)?.quantity ?? 0;
                  return (
                    <article className="booking-menu-item" key={item.id}>
                      <div><span>{item.category}</span><h3>{item.name}</h3><p>{item.description}</p><strong>${item.price.toFixed(2)}</strong></div>
                      <div className="booking-menu-item__quantity">
                        <button type="button" onClick={() => updateItemQty(item, -1)} disabled={quantity === 0} aria-label={`Remove one ${item.name}`}><Minus size={14} /></button>
                        <span aria-live="polite">{quantity}</span>
                        <button type="button" onClick={() => updateItemQty(item, 1)} aria-label={`Add one ${item.name}`}><Plus size={14} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <button type="button" className="booking-skip-link" onClick={goNext}>Skip pre-order and continue <ArrowRight size={15} /></button>
            </section>
          )}

          {currentStep === 4 && (
            <section className="booking-step" aria-labelledby="booking-details-title">
              <div className="booking-step__heading">
                <p className="booking-eyebrow">04 · GUEST DETAILS</p>
                <h2 id="booking-details-title">Who should we look out for?</h2>
                <p>Share one way for the cafe team to contact you about this request.</p>
              </div>
              <div className="booking-form-grid">
                <label className="booking-honeypot" aria-hidden="true">Website<input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
                <label htmlFor="guest-name">Your name<input id="guest-name" type="text" autoComplete="name" maxLength={100} value={formData.customerName} onChange={(event) => setFormData((previous) => ({ ...previous, customerName: event.target.value }))} placeholder="Full name" /></label>
                <label htmlFor="guest-phone">Phone number <span>(optional if you add email)</span><input id="guest-phone" type="tel" autoComplete="tel" maxLength={40} value={formData.customerPhone} onChange={(event) => setFormData((previous) => ({ ...previous, customerPhone: event.target.value }))} placeholder="(555) 014-2020" /></label>
                <label htmlFor="guest-email">Email address <span>(optional if you add phone)</span><input id="guest-email" type="email" autoComplete="email" value={formData.customerEmail} onChange={(event) => setFormData((previous) => ({ ...previous, customerEmail: event.target.value }))} placeholder="you@example.com" /></label>
                <label htmlFor="guest-notes" className="booking-form-grid__wide">Anything we should know? <span>(optional)</span><textarea id="guest-notes" rows={4} maxLength={1000} value={formData.specialRequests} onChange={(event) => setFormData((previous) => ({ ...previous, specialRequests: event.target.value }))} placeholder="Allergies, accessibility needs, or a special occasion…" /></label>
              </div>
            </section>
          )}

          {currentStep === 5 && formData.selectedTable && (
            <section className="booking-step" aria-labelledby="booking-review-title">
              <div className="booking-step__heading">
                <p className="booking-eyebrow">05 · FINAL CHECK</p>
                <h2 id="booking-review-title">Everything look right?</h2>
                <p>Send your request and the cafe team will confirm it shortly.</p>
              </div>
              <div className="booking-review">
                <div className="booking-review__brand"><span>THE CORNER CAFE</span><strong>Reservation request</strong><span className="badge badge-pending">Pending confirmation</span></div>
                <div className="booking-review__grid">
                  <div><span>Date &amp; time</span><strong>{displayDate(formData.date)}<br />{formData.timeSlot}</strong></div>
                  <div><span>Table</span><strong>{formData.selectedTable.id} · Floor {formData.selectedTable.floor}<br />{formData.selectedTable.zone} · {formData.selectedTable.capacity} seats</strong></div>
                  <div><span>Guests</span><strong>{formData.partySize} {formData.partySize === 1 ? 'guest' : 'guests'}</strong></div>
                  <div><span>Reserved for</span><strong>{formData.customerName}<br />{formData.customerPhone || formData.customerEmail}</strong></div>
                </div>
                <div className="booking-review__order">
                  <div><strong>Pre-order</strong><button type="button" onClick={() => setCurrentStep(3)}>Edit</button></div>
                  {formData.preOrders.length ? formData.preOrders.map((entry) => <p key={entry.item.id}><span>{entry.quantity} × {entry.item.name}</span><span>${(entry.item.price * entry.quantity).toFixed(2)}</span></p>) : <p><span>No pre-order added</span><span>Order when you arrive</span></p>}
                  {formData.preOrders.length > 0 && <strong className="booking-review__total">Estimated total <span>${preOrderTotal.toFixed(2)}</span></strong>}
                </div>
                {formData.specialRequests && <p className="booking-review__notes"><strong>Notes:</strong> {formData.specialRequests}</p>}
              </div>
            </section>
          )}

          <div className="booking-navigation">
            {currentStep > 1 ? <button type="button" className="btn btn-ghost" onClick={goBack}><ArrowLeft size={15} /> Back</button> : <span />}
            {currentStep < 5 ? (
              <button type="button" className="btn btn-primary" onClick={goNext}>
                {currentStep === 3 ? 'Continue' : 'Continue'} <ArrowRight size={16} />
              </button>
            ) : (
              <button type="button" className="btn btn-amber" onClick={() => void submitBooking()} disabled={submitting || !availableSlots.includes(formData.timeSlot)}>
                {submitting ? 'Sending request…' : 'Send reservation request'} <ArrowRight size={16} />
              </button>
            )}
          </div>
        </div>
      </section>
      <footer className="booking-footer"><span>THE CORNER CAFE</span><span>Reservations made with care</span></footer>
    </main>
  );
}
