import { useAuthStore } from '../../stores/auth-store';
import { Icon } from './Icon';

export function TokenInspector() {
  const { token, user } = useAuthStore();

  if (!token) return null;

  const isExpired = Date.now() / 1000 > token.expiresAt;
  const timeLeft = Math.max(0, Math.floor(token.expiresAt - Date.now() / 1000));

  return (
    <div className="glass-card !p-4 text-sm font-mono space-y-3">
      <div className="flex items-center gap-2 text-primary-600 font-sans font-semibold">
        <Icon name="token" size={20} />
        <span>Token Inspector</span>
      </div>

      <div className="space-y-2 text-gray-600">
        <div className="flex justify-between">
          <span className="text-gray-400">Type</span>
          <span>CAT (CTA-5007-B)</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Subject</span>
          <span className="truncate max-w-[160px]">{user?.id}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">DPoP</span>
          <span className={token.hasDpop ? 'text-green-600' : 'text-gray-400'}>
            {token.hasDpop ? 'Bound' : 'None'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Expires</span>
          <span className={isExpired ? 'text-red-500' : 'text-green-600'}>
            {isExpired ? 'Expired' : `${timeLeft}s`}
          </span>
        </div>
      </div>

      <div className="border-t border-gray-200/50 pt-2">
        <div className="text-gray-400 mb-1 font-sans text-xs">Scopes</div>
        <div className="space-y-1">
          {token.scopes.map((scope, i) => (
            <div key={i} className="bg-primary-50/50 rounded px-2 py-1 text-xs">
              <span className="text-primary-600">{scope.actions.join(', ')}</span>
              <span className="text-gray-400"> → </span>
              <span>{scope.namespace}</span>
              {scope.track && <span className="text-gray-400">/{scope.track}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-200/50 pt-2">
        <div className="text-gray-400 mb-1 font-sans text-xs">Raw Token</div>
        <div className="bg-gray-100/50 rounded p-2 text-[10px] break-all max-h-20 overflow-y-auto text-gray-500">
          {token.raw}
        </div>
      </div>
    </div>
  );
}
