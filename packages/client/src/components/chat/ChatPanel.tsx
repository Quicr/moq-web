// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

/**
 * @fileoverview Chat Panel Component
 *
 * Real-time chat functionality using MOQT for message transport.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';

export const ChatPanel: React.FC = () => {
  const {
    messages,
    participants,
    participantId,
    displayName,
    addMessage,
    setDisplayName,
  } = useStore();

  const [messageInput, setMessageInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(displayName);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!messageInput.trim()) return;

    const message = {
      id: `msg-${Date.now()}`,
      participantId,
      displayName,
      content: messageInput.trim(),
      timestamp: Date.now(),
    };

    addMessage(message);
    setMessageInput('');

    // TODO: Send via MOQT transport
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNameSave = () => {
    setDisplayName(nameInput.trim() || 'Anonymous');
    setEditingName(false);
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[600px]">
      {/* Chat Messages */}
      <div className="lg:col-span-3 panel flex flex-col">
        <div className="panel-header flex items-center justify-between">
          <span>Chat</span>
          <span className="text-sm font-normal text-gray-500">
            {messages.length} messages
          </span>
        </div>

        {/* Messages List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-400">
              <div className="text-center">
                <svg className="w-12 h-12 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm">No messages yet</p>
                <p className="text-xs mt-1">Start the conversation!</p>
              </div>
            </div>
          ) : (
            messages.map(msg => (
              <div
                key={msg.id}
                className={`chat-message-enter flex ${
                  msg.participantId === participantId ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2 ${
                    msg.participantId === participantId
                      ? 'bg-primary-500 text-white'
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                >
                  {msg.participantId !== participantId && (
                    <div className="text-xs font-medium text-primary-600 dark:text-primary-400 mb-1">
                      {msg.displayName}
                    </div>
                  )}
                  <p className="text-sm break-words">{msg.content}</p>
                  <div
                    className={`text-xs mt-1 ${
                      msg.participantId === participantId
                        ? 'text-primary-200'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Message Input */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <div className="flex gap-2">
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="input flex-1"
            />
            <button
              onClick={handleSend}
              disabled={!messageInput.trim()}
              className="btn-primary"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="space-y-4">
        {/* Your Profile */}
        <div className="panel">
          <div className="panel-header">Your Profile</div>
          <div className="panel-body">
            {editingName ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Enter display name"
                  className="input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNameSave();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                />
                <div className="flex gap-2">
                  <button onClick={handleNameSave} className="btn-primary btn-sm flex-1">
                    Save
                  </button>
                  <button
                    onClick={() => setEditingName(false)}
                    className="btn-secondary btn-sm flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center">
                    <span className="text-primary-600 dark:text-primary-400 font-medium">
                      {displayName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div className="font-medium">{displayName}</div>
                    <div className="text-xs text-gray-500">You</div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setNameInput(displayName);
                    setEditingName(true);
                  }}
                  className="btn-icon btn-secondary"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Participants */}
        <div className="panel flex-1">
          <div className="panel-header flex items-center justify-between">
            <span>Participants</span>
            <span className="badge badge-blue">{participants.length + 1}</span>
          </div>
          <div className="panel-body">
            <div className="space-y-2">
              {/* Self */}
              <div className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-900 rounded-md">
                <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center">
                  <span className="text-sm text-primary-600 dark:text-primary-400 font-medium">
                    {displayName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{displayName}</div>
                  <div className="text-xs text-gray-500">You</div>
                </div>
                <span className="w-2 h-2 rounded-full bg-green-500" />
              </div>

              {/* Other participants */}
              {participants.map(participant => (
                <div
                  key={participant.id}
                  className="flex items-center gap-3 p-2 rounded-md"
                >
                  <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                    <span className="text-sm text-gray-600 dark:text-gray-400 font-medium">
                      {participant.displayName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">{participant.displayName}</div>
                    <div className="text-xs text-gray-500">
                      {Date.now() - participant.lastSeen < 60000 ? 'Online' : 'Offline'}
                    </div>
                  </div>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      Date.now() - participant.lastSeen < 60000
                        ? 'bg-green-500'
                        : 'bg-gray-400'
                    }`}
                  />
                </div>
              ))}

              {participants.length === 0 && (
                <div className="text-center text-gray-400 py-4 text-sm">
                  No other participants yet
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
