import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('reply_maskings')
@Index('idx_sender_receiver_hash', ['senderAddressHash', 'receiverAddressHash'])
export class ReplyMasking {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'reply_address',
  })
  @Index('idx_reply_address')
  replyAddress: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'sender_address',
  })
  senderAddress: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'sender_address_hash',
  })
  senderAddressHash: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'receiver_address',
  })
  receiverAddress: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'receiver_address_hash',
  })
  receiverAddressHash: string;

  @CreateDateColumn({
    type: 'datetime',
    nullable: false,
    name: 'created_at',
  })
  createdAt: Date;

  @Column({
    type: 'datetime',
    nullable: true,
    name: 'last_used_at',
  })
  lastUsedAt: Date | null;
}
