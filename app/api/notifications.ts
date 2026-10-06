import { apiRequest } from '@/api/client';

/** Mirrors the server's InboxItemView (server/src/types/notifications.ts). Never carries addresses, phones or amounts. */
export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string;
  orderId: string | null;
  createdAt: string;
  read: boolean;
}

export interface Inbox {
  notifications: InboxItem[];
  unread: number;
}

export const getInbox = () => apiRequest<Inbox>('/notifications');

export const markRead = (id: string) => apiRequest<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });

export const markAllRead = () => apiRequest<{ marked: number }>('/notifications/read-all', { method: 'POST' });
