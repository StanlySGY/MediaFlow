import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Dialog } from './Dialog';
import { TokenRequest } from '../hooks/useAuth';

interface TokenDialogProps {
  request: TokenRequest;
  currentToken: string;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}

/**
 * The service's access token, entered in the page instead of a browser prompt.
 *
 * The old flow was prompt('需要访问令牌（已启用鉴权）'): an unmasked field in
 * OS chrome, no way to check what you typed, and a blocking call that froze the
 * whole tab — including any upload already in flight.
 */
export const TokenDialog: React.FC<TokenDialogProps> = ({ request, currentToken, onSubmit, onCancel }) => {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);

  return (
    <Dialog
      title={request.reason === 'required' ? '需要访问令牌' : '设置访问令牌'}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() => onSubmit(value)}
          >
            {request.reason === 'required' ? '提交令牌' : '保存'}
          </button>
        </>
      }
    >
      <p className="mb-3">
        {request.reason === 'required'
          ? '服务已启用鉴权，当前请求被拒绝（401）。输入访问令牌后，失败的请求会自动重发。'
          : '令牌保存在本机浏览器。留空并保存会清除令牌，同时结束浏览器侧的会话。'}
      </p>
      <label className="field">
        <span>访问令牌</span>
        <input
          data-autofocus
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit(value);
            }
          }}
          placeholder={currentToken ? '（留空保持不变）' : '粘贴访问令牌'}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field-hint flex items-center gap-1.5">
          <KeyRound className="w-3 h-3" />
          {currentToken ? '已有令牌，输入新值将覆盖它。' : '尚未设置令牌。'}
        </span>
      </label>
      <label className="field check mt-2.5">
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
        显示令牌
      </label>
    </Dialog>
  );
};
