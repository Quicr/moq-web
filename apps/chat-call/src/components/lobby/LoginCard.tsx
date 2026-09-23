import { useAuthStore } from '../../stores/auth-store';
import { Icon } from '../shared/Icon';

export function LoginCard() {
  const { loginWithGoogle, loginAsGuest, isLoading, error, clearError } = useAuthStore();

  return (
    <div className="glass-card max-w-md w-full mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="w-16 h-16 mx-auto bg-gradient-to-br from-primary-400 to-primary-600 rounded-2xl flex items-center justify-center shadow-lg shadow-primary-500/25">
          <Icon name="chat" size={32} className="text-white" />
        </div>
        <h1 className="text-2xl font-bold text-gray-800">MoQ Chat</h1>
        <p className="text-gray-500 text-sm">Real-time media chat powered by MOQT</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
          <Icon name="error" size={18} className="text-red-500 mt-0.5" />
          <div className="flex-1 text-sm text-red-700">{error}</div>
          <button onClick={clearError} className="text-red-400 hover:text-red-600">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <div className="space-y-3">
        <button
          onClick={loginWithGoogle}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-white border border-gray-200 rounded-xl font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 shadow-sm disabled:opacity-50"
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {isLoading ? 'Signing in...' : 'Continue with Google'}
        </button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200/60"></div>
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-white/70 px-3 text-gray-400">or</span>
          </div>
        </div>

        <button
          onClick={loginAsGuest}
          disabled={isLoading}
          className="w-full btn-secondary flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Icon name="person_outline" size={20} />
          Join as Guest
        </button>
      </div>

      <div className="text-center">
        <p className="text-xs text-gray-400">
          Guests can view public rooms. Sign in for full access.
        </p>
      </div>
    </div>
  );
}
