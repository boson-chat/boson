import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { Field } from './Field';

describe('Field', () => {
  it('renders label and child input', () => {
    render(<Field label="Email"><input placeholder="email" /></Field>);
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('email')).toBeInTheDocument();
  });

  it('shows hint when no error', () => {
    render(<Field label="Password" hint="At least 8 characters"><input /></Field>);
    expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
  });

  it('replaces hint with error when error is set', () => {
    render(<Field label="Password" hint="hint" error="Too short"><input /></Field>);
    expect(screen.getByRole('alert')).toHaveTextContent('Too short');
    expect(screen.queryByText('hint')).toBeNull();
  });

  it('marks optional label', () => {
    render(<Field label="Display name" optional><input /></Field>);
    expect(screen.getByText('(optional)', { exact: false })).toBeInTheDocument();
  });
});

describe('Field labelling', () => {
  it('names its control by the label', () => {
    render(<Field label="Hostname"><input placeholder="host" /></Field>);
    expect(screen.getByLabelText('Hostname')).toBe(screen.getByPlaceholderText('host'));
  });

  it("keeps the control's own id", () => {
    render(<Field label="Port"><input id="my-port" /></Field>);
    expect(screen.getByLabelText('Port').id).toBe('my-port');
  });

  it('describes the control with the hint, then the error', () => {
    const { rerender } = render(<Field label="Password" hint="At least 8"><input /></Field>);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAccessibleDescription('At least 8');
    expect(input).not.toHaveAttribute('aria-invalid');
    rerender(<Field label="Password" hint="At least 8" error="Too short"><input /></Field>);
    expect(input).toHaveAccessibleDescription('Too short');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    rerender(<Field label="Password" hint="At least 8"><input /></Field>);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('gives two fields distinct ids', () => {
    render(<><Field label="A"><input /></Field><Field label="B"><input /></Field></>);
    expect(screen.getByLabelText('A')).not.toBe(screen.getByLabelText('B'));
  });
});
