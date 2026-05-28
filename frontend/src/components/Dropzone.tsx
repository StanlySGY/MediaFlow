import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, FileAudio, AlertCircle } from 'lucide-react';

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
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={handleClick}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-300 flex flex-col items-center justify-center gap-4 ${
          isDragActive
            ? 'border-[#5c54f2] bg-[#5c54f2]/8 shadow-lg shadow-[#5c54f2]/5 text-white'
            : 'border-white/10 bg-white/2 hover:border-[#5c54f2]/30 hover:bg-[#5c54f2]/3 hover:shadow-lg hover:shadow-[#5c54f2]/2 hover:text-white text-gray-400'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
        whileHover={disabled ? {} : { scale: 1.005 }}
        whileTap={disabled ? {} : { scale: 0.995 }}
      >
        <motion.div 
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
            isDragActive ? 'bg-[#5c54f2] text-white' : 'bg-[#5c54f2]/10 text-[#5c54f2]'
          }`}
          animate={isDragActive ? { y: -4, scale: 1.05 } : { y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 15 }}
        >
          <UploadCloud className="w-6 h-6" />
        </motion.div>

        <div className="flex flex-col gap-1">
          <strong className="text-white text-sm font-semibold">
            {isDragActive ? '释放以拖入文件' : '点击选择 或 拖拽音频/视频文件到此处'}
          </strong>
          <small className="text-[11px] text-gray-500 max-w-sm mx-auto">
            支持 mp3 / wav / m4a / flac / aac / ogg / mp4 / mov / mkv / pcm 格式
          </small>
        </div>
      </motion.div>
    </div>
  );
};
