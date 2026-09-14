import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock, useToast } from '../components/ui';
import { relative } from '../lib/format';

const SEVERITY_ICON: Record<string, any> = {
  critical: 'alert', warning: 'alert', success: 'check', info: 'dot',
};

export default function Notifications() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { setNotificationCount } = useSession();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get('/notifications?limit=100'),
  });

  const { data: prefs } = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => get('/notifications/preferences'),
    staleTime: 300_000,
  });

  useEffect(() => {
    if (data?.unread !== undefined) setNotificationCount(data.unread);
  }, [data?.unread, setNotificationCount]);

  const markRead = async (ids?: string[]) => {
    try {
      const result = await post('/notifications/read', ids ? { ids } : {});
      setNotificationCount(result.unread);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] });
    } catch (err) { toast.error(err); }
  };

  const savePrefs = async (key: string, value: boolean) => {
    try {
      await post('/settings/profile', { notif_prefs: { ...prefs.preferences, [key]: value } }, { method: 'PATCH' } as any);
      queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
      toast.success('Preference saved.');
    } catch (err) { toast.error(err); }
  };

  const notifications = data?.notifications ?? [];

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {data?.unread ? `${data.unread} unread` : 'You are up to date.'}
          </p>
        </div>
        {data?.unread > 0 && <Button onClick={() => markRead()}>Mark all as read</Button>}
      </div>

      <div className="grid split">
        <Card padded={false}>
          {isLoading ? (
            <div style={{ padding: 14 }}><LoadingBlock rows={5} height={44} /></div>
          ) : error ? (
            <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
          ) : notifications.length === 0 ? (
            <EmptyState icon="bell" title="No notifications" message="Alerts about hot leads, overdue follow-ups and unanswered quotations land here." />
          ) : (
            <div>
              {notifications.map((notification: any) => (
                <button
                  key={notification.id} className="attention-item"
                  style={{
                    width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)',
                    background: notification.read_at ? 'none' : 'var(--surface-2)', font: 'inherit',
                  }}
                  onClick={() => {
                    if (!notification.read_at) markRead([notification.id]);
                    if (notification.link) navigate(`/app${notification.link}`);
                  }}
                >
                  <span style={{
                    color: notification.severity === 'critical' ? 'var(--danger)'
                      : notification.severity === 'warning' ? 'var(--warm)'
                      : notification.severity === 'success' ? 'var(--good)' : 'var(--ink-3)',
                  }}>
                    <Icon name={SEVERITY_ICON[notification.severity] ?? 'dot'} size={16} />
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className={notification.read_at ? '' : 'strong'}>{notification.title}</div>
                    {notification.body && <div className="small muted">{notification.body}</div>}
                    <div className="tiny dim">{relative(notification.created_at)}</div>
                  </div>
                  {!notification.read_at && <span className="dot" style={{ color: 'var(--accent)' }} />}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="What you want to hear about" subtitle="Applies to your account only">
          {!prefs ? <LoadingBlock rows={5} height={24} /> : (
            <div className="col gap-4">
              {Object.entries(prefs.descriptions).map(([key, description]) => (
                <label key={key} className="check">
                  <input
                    type="checkbox"
                    checked={prefs.preferences[key] !== false}
                    onChange={(e) => savePrefs(key, e.target.checked)}
                  />
                  <span className="small">{description as string}</span>
                </label>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
