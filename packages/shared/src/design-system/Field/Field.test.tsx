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
