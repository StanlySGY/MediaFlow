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
        aria-label="点击选择文件，或把音频/视频拖到这里"
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleClick(); }
        }}
        className={`border border-dashed rounded-[10px] px-6 py-10 text-center cursor-pointer transition-colors duration-150 flex flex-col items-center justify-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isDragActive
            ? 'border-accent bg-accent-soft'
            : 'border-border-strong bg-surface-2 hover:border-border-strong'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      >
        <UploadCloud className={`w-5 h-5 ${isDragActive ? 'text-accent' : 'text-muted-2'}`} />

        <div className="flex flex-col gap-1">
          <span className="text-base font-medium text-fg">
            {isDragActive ? '松手即可上传' : '点击选择文件，或把音频/视频拖到这里'}
          </span>
          <span className="text-meta text-muted max-w-md mx-auto">
            支持 mp3 / wav / m4a / flac / aac / ogg / mp4 / mov / mkv / pcm，最长可处理 2 小时以上的录音
          </span>
        </div>
      </motion.div>
    </div>
  );
};
