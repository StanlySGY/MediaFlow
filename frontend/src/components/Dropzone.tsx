import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { UploadCloud } from 'lucide-react';

interface DropzoneProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export const Dropzone: React.FC<DropzoneProps> = ({ onFileSelect, disabled }) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (disabled) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (disabled) return;

    if (e.target.files && e.target.files[0]) {
      onFileSelect(e.target.files[0]);
    }
  };

  const handleClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  return (
    <div className="relative">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleChange}
        hidden
        accept="audio/*,video/*,.pcm"
        disabled={disabled}
      />
      
      <motion.div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="选择或拖拽音频/视频文件上传"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleClick(); }
        }}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center gap-4 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isDragActive
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border-strong bg-surface-2 hover:border-accent/50 hover:bg-accent-soft/50 text-fg-dim'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
        whileHover={disabled ? {} : { scale: 1.005 }}
        whileTap={disabled ? {} : { scale: 0.995 }}
      >
        <motion.div
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
            isDragActive ? 'bg-accent text-white' : 'bg-accent-soft text-accent'
          }`}
          animate={isDragActive ? { y: -4, scale: 1.05 } : { y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 15 }}
        >
          <UploadCloud className="w-6 h-6" />
        </motion.div>

        <div className="flex flex-col gap-1">
          <strong className="text-fg text-sm font-semibold">
            {isDragActive ? '松手即可上传' : '点击选择文件，或把音频/视频拖到这里'}
          </strong>
          <small className="text-[11.5px] text-muted max-w-md mx-auto">
            支持 mp3 / wav / m4a / flac / aac / ogg / mp4 / mov / mkv / pcm，最长可处理 2 小时以上的录音
          </small>
        </div>
      </motion.div>
    </div>
  );
};
