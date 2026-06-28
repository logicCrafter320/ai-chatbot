import { useState, useRef, useCallback, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { 
  useListOpenaiConversations, 
  useCreateOpenaiConversation,
  useGetOpenaiConversation,
  useDeleteOpenaiConversation,
  getGetOpenaiConversationQueryKey,
  getListOpenaiConversationsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Plus, MessageSquare, Trash2, Send, Bot, User, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

export default function Home() {
  const [location, setLocation] = useLocation();
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: conversations, isLoading: isLoadingConvs } = useListOpenaiConversations();
  const createConv = useCreateOpenaiConversation();
  const deleteConv = useDeleteOpenaiConversation();

  const { data: activeConv, isLoading: isLoadingConv } = useGetOpenaiConversation(
    activeConvId as number, 
    { query: { enabled: !!activeConvId, queryKey: getGetOpenaiConversationQueryKey(activeConvId as number) } }
  );

  const [input, setInput] = useState("");
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<Array<{id: number, role: string, content: string, createdAt: string}>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeConv?.messages, optimisticMessages, streamingMessage]);

  // Reset state when changing conversation
  useEffect(() => {
    setOptimisticMessages([]);
    setStreamingMessage("");
    setIsStreaming(false);
  }, [activeConvId]);

  const streamMessage = async (convId: number, content: string) => {
    setIsStreaming(true);
    setStreamingMessage("");
    try {
      const res = await fetch(`/api/openai/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      
      if (!res.ok) throw new Error("Failed to send message");
      
      const reader = res.body?.getReader();
      if (!reader) return;
      
      const decoder = new TextDecoder();
      let streamContent = "";
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(line => line.trim().startsWith("data: "));
        
        for (const line of lines) {
          const dataStr = line.replace("data: ", "").trim();
          if (dataStr === "[DONE]") continue;
          
          try {
            const data = JSON.parse(dataStr);
            if (data.content) {
              streamContent += data.content;
              setStreamingMessage(streamContent);
              scrollToBottom();
            }
            if (data.done) {
              break;
            }
          } catch (e) {
            console.error("Failed to parse SSE data", e);
          }
        }
      }
      
      // Refresh the conversation to get the final message IDs
      queryClient.invalidateQueries({ queryKey: getGetOpenaiConversationQueryKey(convId) });
    } catch (err) {
      console.error(err);
    } finally {
      setIsStreaming(false);
      setStreamingMessage("");
      setOptimisticMessages([]);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    
    const userMsgContent = input.trim();
    setInput("");
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (!activeConvId) {
      // Create new conversation
      createConv.mutate({ data: { title: userMsgContent.substring(0, 40) + (userMsgContent.length > 40 ? "..." : "") } }, {
        onSuccess: async (conv) => {
          setActiveConvId(conv.id);
          queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
          
          // Add optimistic user message
          setOptimisticMessages([{
            id: Date.now(),
            role: "user",
            content: userMsgContent,
            createdAt: new Date().toISOString()
          }]);
          
          await streamMessage(conv.id, userMsgContent);
        }
      });
    } else {
      // Add optimistic user message
      setOptimisticMessages(prev => [...prev, {
        id: Date.now(),
        role: "user",
        content: userMsgContent,
        createdAt: new Date().toISOString()
      }]);
      
      await streamMessage(activeConvId, userMsgContent);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDeleteConv = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    deleteConv.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        if (activeConvId === id) {
          setActiveConvId(null);
        }
      }
    });
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const allMessages = [...(activeConv?.messages || []), ...optimisticMessages];

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground selection:bg-primary/30">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300">
        <div className="p-4 border-b border-sidebar-border">
          <Button 
            className="w-full justify-start gap-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 shadow-none" 
            onClick={() => setActiveConvId(null)}
          >
            <Plus className="h-4 w-4" />
            New Chat
          </Button>
        </div>
        <ScrollArea className="flex-1 px-3 py-2">
          <div className="space-y-1">
            {isLoadingConvs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : conversations?.map((conv) => (
              <div
                key={conv.id}
                onClick={() => setActiveConvId(conv.id)}
                className={cn(
                  "group flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition-colors text-sm",
                  activeConvId === conv.id 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-70" />
                  <span className="truncate">{conv.title || "New Conversation"}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
                  onClick={(e) => handleDeleteConv(e, conv.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {conversations?.length === 0 && !isLoadingConvs && (
              <div className="text-center py-8 text-xs text-sidebar-foreground/50">
                No conversations yet
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background relative">
        {/* Header */}
        <header className="h-14 flex-shrink-0 border-b border-border flex items-center px-6 bg-background/80 backdrop-blur-sm z-10">
          <h1 className="font-medium truncate opacity-90">
            {activeConvId ? activeConv?.title : "New Chat"}
          </h1>
        </header>

        {/* Messages */}
        <ScrollArea className="flex-1 p-6">
          <div className="max-w-3xl mx-auto space-y-6 pb-24">
            {!activeConvId && optimisticMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[50vh] text-center space-y-4">
                <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20">
                  <Bot className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">How can I help you today?</h2>
                <p className="text-muted-foreground text-sm max-w-sm">
                  Send a message to start a new conversation. I can answer questions, help with code, and more.
                </p>
              </div>
            ) : isLoadingConv && activeConvId && optimisticMessages.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {allMessages.map((msg, i) => (
                  <div 
                    key={msg.id || i} 
                    className={cn(
                      "flex gap-4 message-fade-in max-w-[85%]",
                      msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                    )}
                  >
                    <div className={cn(
                      "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border shadow-sm",
                      msg.role === "user" 
                        ? "bg-secondary border-border" 
                        : "bg-primary border-primary text-primary-foreground"
                    )}>
                      {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </div>
                    <div className={cn(
                      "flex flex-col gap-1",
                      msg.role === "user" ? "items-end" : "items-start"
                    )}>
                      <div className={cn(
                        "px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap",
                        msg.role === "user" 
                          ? "bg-secondary text-secondary-foreground rounded-tr-sm" 
                          : "bg-card border border-border shadow-sm rounded-tl-sm"
                      )}>
                        {msg.content}
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 px-1 font-mono">
                        {msg.createdAt && format(new Date(msg.createdAt), "h:mm a")}
                      </span>
                    </div>
                  </div>
                ))}
                
                {/* Streaming Message */}
                {isStreaming && streamingMessage && (
                  <div className="flex gap-4 message-fade-in max-w-[85%] mr-auto">
                    <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border bg-primary border-primary text-primary-foreground shadow-sm">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1 items-start">
                      <div className="px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap bg-card border border-border shadow-sm rounded-tl-sm">
                        {streamingMessage}
                        <span className="typewriter-cursor"></span>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Typing indicator */}
                {isStreaming && !streamingMessage && (
                  <div className="flex gap-4 message-fade-in max-w-[85%] mr-auto">
                    <div className="h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 border bg-primary border-primary text-primary-foreground shadow-sm">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1 items-start">
                      <div className="px-4 py-4 rounded-2xl bg-card border border-border shadow-sm rounded-tl-sm flex items-center gap-1.5 h-11">
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"/></svg>
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"/></svg>
                        <svg className="h-1.5 w-1.5 text-muted-foreground typing-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"/></svg>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="p-4 bg-background/80 backdrop-blur-sm border-t border-border mt-auto">
          <div className="max-w-3xl mx-auto relative flex items-end shadow-sm bg-card rounded-xl border border-input focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-shadow">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                handleInput(e);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Message AI..."
              className="min-h-[52px] max-h-[200px] w-full resize-none border-0 shadow-none focus-visible:ring-0 rounded-xl bg-transparent py-3.5 pl-4 pr-12 text-sm text-card-foreground font-mono"
              rows={1}
            />
            <Button
              size="icon"
              className={cn(
                "absolute right-2 bottom-2 h-9 w-9 rounded-lg transition-all",
                input.trim() && !isStreaming 
                  ? "bg-primary text-primary-foreground hover:bg-primary/90" 
                  : "bg-secondary text-muted-foreground hover:bg-secondary opacity-50 cursor-not-allowed"
              )}
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-w-3xl mx-auto text-center mt-2">
            <span className="text-[10px] text-muted-foreground/60">
              AI can make mistakes. Consider verifying important information.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
