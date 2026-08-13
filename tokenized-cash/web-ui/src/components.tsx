export const Card = ({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) => (
  <div className={`bg-white rounded-lg shadow p-4 ${className}`}>
    {title && <h3 className="font-semibold text-gray-700 mb-3">{title}</h3>}
    {children}
  </div>
);

export const Button = ({ children, onClick, disabled, variant = 'primary', className = '' }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger'; className?: string
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`px-4 py-2 rounded font-medium transition-colors disabled:opacity-50 ${className} ${
      variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700' :
      variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' :
      'bg-gray-200 text-gray-700 hover:bg-gray-300'
    }`}
  >
    {children}
  </button>
);

export const Input = ({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    <input {...props} className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
  </div>
);
