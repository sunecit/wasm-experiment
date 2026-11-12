(module
  (memory (export "memory") 4)
  (global $heap (mut i32) (i32.const 4096))

  (func (export "reset_allocator")
    i32.const 4096
    global.set $heap)

  (func (export "alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local $end i32)
    global.get $heap
    local.tee $ptr
    local.get $size
    i32.const 7
    i32.add
    i32.const -8
    i32.and
    i32.add
    local.tee $end
    memory.size
    i32.const 65536
    i32.mul
    i32.gt_u
    if
      local.get $end
      memory.size
      i32.const 65536
      i32.mul
      i32.sub
      i32.const 65535
      i32.add
      i32.const 65536
      i32.div_u
      memory.grow
      i32.const -1
      i32.eq
      if
        unreachable ;; Завершаем выполнение, если движок не может выделить запрошенную память.
      end
    end
    local.get $end
    global.set $heap
    local.get $ptr)

  (func $clamp (param $value i32) (result i32)
    local.get $value
    i32.const 0
    i32.lt_s
    if (result i32)
      i32.const 0
    else
      local.get $value
      i32.const 255
      i32.gt_s
      if (result i32)
        i32.const 255
      else
        local.get $value
      end
    end)

  (func (export "grayscale") (param $ptr i32) (param $len i32)
    (local $i i32)
    (local $gray i32)
    loop $loop
      local.get $i
      local.get $len
      i32.ge_u
      br_if 1
      local.get $ptr
      local.get $i
      i32.add
      i32.load8_u
      local.get $ptr
      local.get $i
      i32.add
      i32.const 1
      i32.add
      i32.load8_u
      i32.add
      local.get $ptr
      local.get $i
      i32.add
      i32.const 2
      i32.add
      i32.load8_u
      i32.add
      i32.const 3
      i32.div_u
      local.set $gray
      local.get $ptr local.get $i i32.add local.get $gray i32.store8
      local.get $ptr local.get $i i32.add i32.const 1 i32.add local.get $gray i32.store8
      local.get $ptr local.get $i i32.add i32.const 2 i32.add local.get $gray i32.store8
      local.get $i i32.const 4 i32.add local.set $i
      br $loop
    end)

  (func (export "invert") (param $ptr i32) (param $len i32)
    (local $i i32)
    (local $channel i32)
    loop $loop
      local.get $i local.get $len i32.ge_u br_if 1
      i32.const 0 local.set $channel
      loop $channels
        local.get $ptr local.get $i i32.add local.get $channel i32.add
        i32.const 255
        local.get $ptr local.get $i i32.add local.get $channel i32.add i32.load8_u
        i32.sub
        i32.store8
        local.get $channel i32.const 1 i32.add local.tee $channel i32.const 3 i32.lt_u br_if $channels
      end
      local.get $i i32.const 4 i32.add local.set $i
      br $loop
    end)

  (func (export "brightness") (param $ptr i32) (param $len i32) (param $delta i32)
    (local $i i32)
    (local $channel i32)
    loop $loop
      local.get $i local.get $len i32.ge_u br_if 1
      i32.const 0 local.set $channel
      loop $channels
        local.get $ptr local.get $i i32.add local.get $channel i32.add
        local.get $ptr local.get $i i32.add local.get $channel i32.add i32.load8_u
        local.get $delta i32.add call $clamp i32.store8
        local.get $channel i32.const 1 i32.add local.tee $channel i32.const 3 i32.lt_u br_if $channels
      end
      local.get $i i32.const 4 i32.add local.set $i
      br $loop
    end)

  (func (export "contrast") (param $ptr i32) (param $len i32) (param $factor i32)
    (local $i i32)
    (local $channel i32)
    loop $loop
      local.get $i local.get $len i32.ge_u br_if 1
      i32.const 0 local.set $channel
      loop $channels
        local.get $ptr local.get $i i32.add local.get $channel i32.add
        local.get $ptr local.get $i i32.add local.get $channel i32.add i32.load8_u
        i32.const 128 i32.sub
        local.get $factor i32.mul
        i32.const 1000 i32.div_s
        i32.const 128 i32.add
        call $clamp i32.store8
        local.get $channel i32.const 1 i32.add local.tee $channel i32.const 3 i32.lt_u br_if $channels
      end
      local.get $i i32.const 4 i32.add local.set $i
      br $loop
    end)

  (func $copy_pixel (param $src i32) (param $dst i32)
    local.get $dst local.get $src i32.load i32.store)

  (func (export "resize_nearest")
    (param $src i32) (param $width i32) (param $height i32)
    (param $dst i32) (param $target_width i32) (param $target_height i32)
    (local $x i32) (local $y i32) (local $sx i32) (local $sy i32)
    block $rows_done
    loop $rows
      local.get $y local.get $target_height i32.ge_u br_if $rows_done
      i32.const 0 local.set $x
      block $columns_done
      loop $columns
        local.get $x local.get $target_width i32.ge_u br_if $columns_done
        local.get $x local.get $width i32.mul local.get $target_width i32.div_u local.set $sx
        local.get $y local.get $height i32.mul local.get $target_height i32.div_u local.set $sy
        local.get $src local.get $sy local.get $width i32.mul local.get $sx i32.add i32.const 4 i32.mul i32.add
        local.get $dst local.get $y local.get $target_width i32.mul local.get $x i32.add i32.const 4 i32.mul i32.add
        call $copy_pixel
        local.get $x i32.const 1 i32.add local.set $x
        br $columns
      end end
      local.get $y i32.const 1 i32.add local.set $y
      br $rows
    end end)

  (func (export "flip_horizontal") (param $ptr i32) (param $width i32) (param $height i32)
    (local $x i32) (local $y i32) (local $left i32) (local $right i32) (local $pixel i32)
    block $rows_done
    loop $rows
      local.get $y local.get $height i32.ge_u br_if $rows_done
      i32.const 0 local.set $x
      block $columns_done
      loop $columns
        local.get $x local.get $width i32.const 2 i32.div_u i32.ge_u br_if $columns_done
        local.get $ptr local.get $y local.get $width i32.mul local.get $x i32.add i32.const 4 i32.mul i32.add local.set $left
        local.get $ptr local.get $y local.get $width i32.mul local.get $width i32.const 1 i32.sub local.get $x i32.sub i32.add i32.const 4 i32.mul i32.add local.set $right
        local.get $left i32.load local.set $pixel
        local.get $left local.get $right i32.load i32.store
        local.get $right local.get $pixel i32.store
        local.get $x i32.const 1 i32.add local.set $x
        br $columns
      end end
      local.get $y i32.const 1 i32.add local.set $y
      br $rows
    end end)

  (func (export "flip_vertical") (param $ptr i32) (param $width i32) (param $height i32)
    (local $x i32) (local $y i32) (local $top i32) (local $bottom i32) (local $pixel i32)
    block $rows_done
    loop $rows
      local.get $y local.get $height i32.const 2 i32.div_u i32.ge_u br_if $rows_done
      i32.const 0 local.set $x
      block $columns_done
      loop $columns
        local.get $x local.get $width i32.ge_u br_if $columns_done
        local.get $ptr local.get $y local.get $width i32.mul local.get $x i32.add i32.const 4 i32.mul i32.add local.set $top
        local.get $ptr local.get $height i32.const 1 i32.sub local.get $y i32.sub local.get $width i32.mul local.get $x i32.add i32.const 4 i32.mul i32.add local.set $bottom
        local.get $top i32.load local.set $pixel
        local.get $top local.get $bottom i32.load i32.store
        local.get $bottom local.get $pixel i32.store
        local.get $x i32.const 1 i32.add local.set $x
        br $columns
      end end
      local.get $y i32.const 1 i32.add local.set $y
      br $rows
    end end)

  (func (export "rotate90") (param $src i32) (param $width i32) (param $height i32) (param $dst i32)
    (local $x i32) (local $y i32) (local $dest_x i32) (local $dest_y i32)
    block $rows_done
    loop $rows
      local.get $y local.get $height i32.ge_u br_if $rows_done
      i32.const 0 local.set $x
      block $columns_done
      loop $columns
        local.get $x local.get $width i32.ge_u br_if $columns_done
        local.get $height i32.const 1 i32.sub local.get $y i32.sub local.set $dest_x
        local.get $x local.set $dest_y
        local.get $src local.get $y local.get $width i32.mul local.get $x i32.add i32.const 4 i32.mul i32.add
        local.get $dst local.get $dest_y local.get $height i32.mul local.get $dest_x i32.add i32.const 4 i32.mul i32.add
        call $copy_pixel
        local.get $x i32.const 1 i32.add local.set $x
        br $columns
      end end
      local.get $y i32.const 1 i32.add local.set $y
      br $rows
    end end)

  (func (export "analyze") (param $ptr i32) (param $len i32) (param $out i32)
    (local $i i32) (local $r i32) (local $g i32) (local $b i32)
    (local $min i32) (local $max i32) (local $hash i32)
    (local $rs i64) (local $gs i64) (local $bs i64)
    i32.const 255 local.set $min
    i32.const 0 local.set $max
    i32.const -2128831035 local.set $hash
    block $done
    loop $loop
      local.get $i local.get $len i32.ge_u br_if $done
      local.get $ptr local.get $i i32.add i32.load8_u local.tee $r i64.extend_i32_u local.get $rs i64.add local.set $rs
      local.get $ptr local.get $i i32.add i32.const 1 i32.add i32.load8_u local.tee $g i64.extend_i32_u local.get $gs i64.add local.set $gs
      local.get $ptr local.get $i i32.add i32.const 2 i32.add i32.load8_u local.tee $b i64.extend_i32_u local.get $bs i64.add local.set $bs
      local.get $r local.get $min i32.lt_u if local.get $r local.set $min end
      local.get $g local.get $min i32.lt_u if local.get $g local.set $min end
      local.get $b local.get $min i32.lt_u if local.get $b local.set $min end
      local.get $r local.get $max i32.gt_u if local.get $r local.set $max end
      local.get $g local.get $max i32.gt_u if local.get $g local.set $max end
      local.get $b local.get $max i32.gt_u if local.get $b local.set $max end
      local.get $hash local.get $r i32.xor i32.const 16777619 i32.mul local.set $hash
      local.get $hash local.get $g i32.xor i32.const 16777619 i32.mul local.set $hash
      local.get $hash local.get $b i32.xor i32.const 16777619 i32.mul local.set $hash
      local.get $hash local.get $ptr local.get $i i32.add i32.const 3 i32.add i32.load8_u i32.xor i32.const 16777619 i32.mul local.set $hash
      local.get $i i32.const 4 i32.add local.set $i
      br $loop
    end end
    local.get $out local.get $rs i64.store
    local.get $out i32.const 8 i32.add local.get $gs i64.store
    local.get $out i32.const 16 i32.add local.get $bs i64.store
    local.get $out i32.const 24 i32.add local.get $min i32.store
    local.get $out i32.const 28 i32.add local.get $max i32.store
    local.get $out i32.const 32 i32.add local.get $hash i32.store
    local.get $out i32.const 36 i32.add local.get $len i32.const 4 i32.div_u i32.store)
)
