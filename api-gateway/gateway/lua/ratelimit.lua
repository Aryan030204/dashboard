local limit_req = require("resty.limit.req")

local _M = {}

-- Limits
local LIMITS = {
    ip = { rate = 100 / 60, burst = 20 },      -- 100 req/min
    user = { rate = 1000 / 60, burst = 100 },  -- 1000 req/min
    brand = { rate = 5000 / 60, burst = 500 }, -- 5000 req/min
    admin = { rate = 50 / 60, burst = 10 },    -- 50 req/min/user for admin
}

function _M.check_limit(key, limit_type, custom_rate, custom_burst)
    local rate = custom_rate or LIMITS[limit_type].rate
    local burst = custom_burst or LIMITS[limit_type].burst
    
    local lim, err = limit_req.new("rate_limit_store", rate, burst)
    if not lim then
        ngx.log(ngx.ERR, "failed to instantiate limit_req: ", err)
        return nil
    end

    local delay, err = lim:incoming(key, true)
    if not delay then
        if err == "rejected" then
            return false -- Limit exceeded
        end
        ngx.log(ngx.ERR, "failed to limit req: ", err)
        return true -- Fail open (allow request on error)
    end

    if delay >= 0.001 then
        -- We can sleep here to rate limit properly (traffic shaping)
        ngx.sleep(delay)
    end

    return true
end

function _M.enforce()
    -- In dev, bypass rate limiting to avoid latency
    if os.getenv("RATE_LIMIT_DISABLED") == "1" then
        return
    end

    local ip = ngx.var.binary_remote_addr
    local user_id = ngx.req.get_headers()["x-user-id"]
    local brand_id = ngx.req.get_headers()["x-brand-id"]
    local uri = ngx.var.uri

    -- Improvement 1: Normalized Order (IP -> User -> Brand -> Admin)

    -- 1. IP Level (Always applied)
    if not _M.check_limit(ip, "ip") then
        ngx.status = 429
        ngx.say("Too Many Requests (IP)")
        ngx.exit(429)
    end

    -- 2. User Level (If authenticated)
    if user_id then
        if not _M.check_limit("user:"..user_id, "user") then
           ngx.status = 429
           ngx.say("Too Many Requests (User)")
           ngx.exit(429) 
        end
    end

    -- 3. Brand Level (If authenticated)
    if brand_id then
        if not _M.check_limit("brand:"..brand_id, "brand") then
             ngx.status = 429
             ngx.say("Too Many Requests (Brand)")
             ngx.exit(429)
        end
    end

    -- 4. Admin Level (If Authenticated AND Admin route)
    if user_id and uri:find("^/admin") then
         if not _M.check_limit("admin:"..user_id, "admin") then
             ngx.status = 429
             ngx.say("Too Many Requests (Admin)")
             ngx.exit(429)
         end
    end
end

return _M
