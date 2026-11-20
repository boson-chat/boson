import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('title, text and an action', () => {
    render(<EmptyState title="No friends yet" action={<button type="button">Add</button>}>Add someone by their handle.</EmptyState>);
    expect(screen.getByText('No friends yet')).toBeTruthy();
    expect(screen.getByText('Add someone by their handle.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});
